#include "db_reconciler.h"

#include <iostream>

#include <libpq-fe.h>

namespace fnvr {

std::vector<CameraConfig> ReadEnabledCameras(const std::string& url) {
    std::vector<CameraConfig> out;

    PGconn* conn = PQconnectdb(url.c_str());
    if (PQstatus(conn) != CONNECTION_OK) {
        std::cerr << "db: connect failed: " << PQerrorMessage(conn);
        PQfinish(conn);
        return out;
    }

    const char* q =
        "SELECT id, url, COALESCE(substream,''), record_mode "
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
        out.push_back(std::move(c));
    }
    PQclear(r);
    PQfinish(conn);
    return out;
}

}  // namespace fnvr
