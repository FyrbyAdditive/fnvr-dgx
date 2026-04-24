#include "db_reconciler.h"

#include <iostream>
#include <string_view>

#include <libpq-fe.h>

namespace fnvr {
namespace {

// parseJsonStringArray extracts the string elements from a compact JSON
// array like `["a","b","c"]`. Tolerates whitespace, `[]`, and garbage
// (returns partial / empty on malformed input — the caller is expected
// to fail open on the mute-list side). No dependency on a JSON lib; the
// shape is fixed by api-server's settings writer.
std::set<std::string> parseJsonStringArray(std::string_view s) {
    std::set<std::string> out;
    size_t i = 0, n = s.size();
    auto skipWs = [&]() {
        while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' ||
                         s[i] == '\r')) i++;
    };
    skipWs();
    if (i >= n || s[i] != '[') return out;
    i++;
    while (i < n) {
        skipWs();
        if (i < n && s[i] == ']') return out;
        if (i >= n || s[i] != '"') return out;
        i++;
        std::string v;
        while (i < n && s[i] != '"') {
            if (s[i] == '\\' && i + 1 < n) {
                // Class labels are ASCII — unescape common cases only.
                char c = s[i + 1];
                switch (c) {
                    case '"':  v += '"';  break;
                    case '\\': v += '\\'; break;
                    case 'n':  v += '\n'; break;
                    case 't':  v += '\t'; break;
                    default:   v += c;    break;
                }
                i += 2;
            } else {
                v += s[i++];
            }
        }
        if (i >= n) return out;
        i++; // closing quote
        if (!v.empty()) out.insert(std::move(v));
        skipWs();
        if (i < n && s[i] == ',') { i++; continue; }
        if (i < n && s[i] == ']') return out;
        return out;
    }
    return out;
}

// parsePgArray extracts string elements from a libpq TEXT[] value like
// `{a,"b c",d}`. Postgres quotes elements that contain special chars;
// COCO labels with spaces ("fire hydrant") come back quoted. No
// attempt at full Postgres escape-handling — class names never contain
// backslashes.
std::vector<std::string> parsePgArray(std::string_view s) {
    std::vector<std::string> out;
    size_t i = 0, n = s.size();
    if (n < 2 || s[0] != '{' || s[n - 1] != '}') return out;
    i = 1;
    while (i < n - 1) {
        std::string v;
        if (s[i] == '"') {
            i++;
            while (i < n - 1 && s[i] != '"') {
                if (s[i] == '\\' && i + 1 < n - 1) { v += s[i + 1]; i += 2; }
                else { v += s[i++]; }
            }
            if (i < n - 1 && s[i] == '"') i++;
        } else {
            while (i < n - 1 && s[i] != ',') v += s[i++];
        }
        if (!v.empty()) out.push_back(std::move(v));
        if (i < n - 1 && s[i] == ',') i++;
    }
    return out;
}

std::string pgGetValueOrEmpty(PGresult* r, int row, int col) {
    if (PQgetisnull(r, row, col)) return {};
    return PQgetvalue(r, row, col);
}

}  // namespace

std::vector<CameraConfig> ReadEnabledCameras(const std::string& url) {
    std::vector<CameraConfig> out;

    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        std::cerr << "db: connect failed: " << PQerrorMessage(conn);
        PQfinish(conn);
        return out;
    }

    const char* q =
        "SELECT id, url, COALESCE(substream,''), record_mode, rotation, "
        "       enabled_detectors, mtx_proxy "
        "FROM cameras WHERE enabled = TRUE "
        "ORDER BY created_at ASC";
    PGresult* r = PQexec(conn, q);
    if (PQresultStatus(r) != PGRES_TUPLES_OK) {
        std::cerr << "db: query failed: " << PQerrorMessage(conn);
        PQclear(r);
        PQfinish(conn);
        return out;
    }

    const int n = PQntuples(r);
    out.reserve(n);
    for (int i = 0; i < n; i++) {
        CameraConfig c;
        c.id             = PQgetvalue(r, i, 0);
        c.url            = PQgetvalue(r, i, 1);
        c.substream_url  = PQgetvalue(r, i, 2);
        c.recording_mode = PQgetvalue(r, i, 3);
        try {
            c.rotation = std::stoi(PQgetvalue(r, i, 4));
        } catch (...) {
            c.rotation = 0;
        }
        c.enabled_detectors = parsePgArray(pgGetValueOrEmpty(r, i, 5));
        {
            std::string v = pgGetValueOrEmpty(r, i, 6);
            c.mtx_proxy = (v == "t" || v == "true" || v == "1");
        }
        out.push_back(std::move(c));
    }
    PQclear(r);
    PQfinish(conn);
    return out;
}

std::set<std::string> ReadMutedClassesForCamera(
    const std::string& url, const std::string& camera_id) {
    std::set<std::string> out;

    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        std::cerr << "db[mutes]: connect failed: " << PQerrorMessage(conn);
        PQfinish(conn);
        return out;
    }

    // 1) The three global buckets. Missing row = empty bucket.
    const char* q1 =
        "SELECT key, value::text FROM settings WHERE key IN ("
        "'classes.disabled.global','classes.disabled.indoor',"
        "'classes.disabled.outdoor')";
    PGresult* r1 = PQexec(conn, q1);
    std::set<std::string> global, indoor, outdoor;
    if (PQresultStatus(r1) == PGRES_TUPLES_OK) {
        for (int i = 0; i < PQntuples(r1); i++) {
            std::string_view k = PQgetvalue(r1, i, 0);
            std::string_view v = PQgetvalue(r1, i, 1);
            auto parsed = parseJsonStringArray(v);
            if (k == "classes.disabled.global")  global  = std::move(parsed);
            else if (k == "classes.disabled.indoor")  indoor  = std::move(parsed);
            else if (k == "classes.disabled.outdoor") outdoor = std::move(parsed);
        }
    } else {
        std::cerr << "db[mutes]: settings query failed: " << PQerrorMessage(conn);
    }
    PQclear(r1);

    // 2) Per-camera row. A missing row = camera was deleted mid-spawn,
    // just return empty (worker will exit shortly anyway).
    const char* q2 =
        "SELECT location_kind, mute_classes_override, unmute_classes_override "
        "FROM cameras WHERE id = $1";
    const char* params[1] = { camera_id.c_str() };
    PGresult* r2 = PQexecParams(conn, q2, 1, nullptr, params, nullptr, nullptr, 0);
    std::string location;
    std::vector<std::string> muteOv, unmuteOv;
    if (PQresultStatus(r2) == PGRES_TUPLES_OK && PQntuples(r2) == 1) {
        location = pgGetValueOrEmpty(r2, 0, 0);
        muteOv   = parsePgArray(pgGetValueOrEmpty(r2, 0, 1));
        unmuteOv = parsePgArray(pgGetValueOrEmpty(r2, 0, 2));
    } else if (PQresultStatus(r2) != PGRES_TUPLES_OK) {
        std::cerr << "db[mutes]: camera query failed: " << PQerrorMessage(conn);
    }
    PQclear(r2);
    PQfinish(conn);

    // 3) Resolve per the formula.
    out = global;
    if (location == "indoor") out.insert(indoor.begin(), indoor.end());
    else if (location == "outdoor") out.insert(outdoor.begin(), outdoor.end());
    for (const auto& c : unmuteOv) out.erase(c);
    for (const auto& c : muteOv)   out.insert(c);
    return out;
}

int ReadRotationForCamera(
    const std::string& url, const std::string& camera_id) {
    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        std::cerr << "db[rot]: connect failed: " << PQerrorMessage(conn);
        PQfinish(conn);
        return 0;
    }
    const char* q = "SELECT rotation FROM cameras WHERE id = $1";
    const char* params[1] = { camera_id.c_str() };
    PGresult* r = PQexecParams(conn, q, 1, nullptr, params, nullptr, nullptr, 0);
    int rotation = 0;
    if (PQresultStatus(r) == PGRES_TUPLES_OK && PQntuples(r) == 1) {
        try {
            rotation = std::stoi(PQgetvalue(r, 0, 0));
        } catch (...) {
            rotation = 0;
        }
    }
    PQclear(r);
    PQfinish(conn);
    return rotation;
}

std::vector<std::string> ReadEnabledDetectorsForCamera(
    const std::string& url, const std::string& camera_id) {
    std::vector<std::string> out;
    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        std::cerr << "db[det]: connect failed: " << PQerrorMessage(conn);
        PQfinish(conn);
        return out;
    }
    const char* q = "SELECT enabled_detectors FROM cameras WHERE id = $1";
    const char* params[1] = { camera_id.c_str() };
    PGresult* r = PQexecParams(conn, q, 1, nullptr, params, nullptr, nullptr, 0);
    if (PQresultStatus(r) == PGRES_TUPLES_OK && PQntuples(r) == 1) {
        out = parsePgArray(pgGetValueOrEmpty(r, 0, 0));
    }
    PQclear(r);
    PQfinish(conn);
    return out;
}

int ReadPipelineStartupGraceSec(const std::string& url) {
    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        PQfinish(conn);
        return 60;
    }
    const char* q = "SELECT value::text FROM settings WHERE key='pipeline.startup_grace_sec'";
    PGresult* r = PQexec(conn, q);
    int sec = 60;
    if (PQresultStatus(r) == PGRES_TUPLES_OK && PQntuples(r) == 1) {
        // Stored as a JSON number, which is just its string form.
        try {
            sec = std::stoi(PQgetvalue(r, 0, 0));
        } catch (...) {
            sec = 60;
        }
        if (sec < 0) sec = 0;
        if (sec > 600) sec = 600;
    }
    PQclear(r);
    PQfinish(conn);
    return sec;
}

bool ReadMtxProxyForCamera(
    const std::string& url, const std::string& camera_id) {
    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        std::cerr << "db[mtx]: connect failed: " << PQerrorMessage(conn);
        PQfinish(conn);
        return false;
    }
    const char* q = "SELECT mtx_proxy FROM cameras WHERE id = $1";
    const char* params[1] = { camera_id.c_str() };
    PGresult* r = PQexecParams(conn, q, 1, nullptr, params, nullptr, nullptr, 0);
    bool mtx = false;
    if (PQresultStatus(r) == PGRES_TUPLES_OK && PQntuples(r) == 1) {
        std::string v = pgGetValueOrEmpty(r, 0, 0);
        mtx = (v == "t" || v == "true" || v == "1");
    }
    PQclear(r);
    PQfinish(conn);
    return mtx;
}

}  // namespace fnvr
