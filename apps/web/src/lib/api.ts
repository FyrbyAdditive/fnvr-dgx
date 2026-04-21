const base = "/api/v1";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 401) {
    // Session expired or never established — bounce to login.
    if (typeof window !== "undefined" && !window.location.pathname.endsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }
    throw new ApiError(res.status, body || `${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export type Camera = {
  id: string;
  name: string;
  url: string;
  substream?: string;
  record_mode: string;
  enabled: boolean;
  enabled_detectors?: string[];
  location_kind?: "indoor" | "outdoor" | null;
  mute_classes_override?: string[];
  unmute_classes_override?: string[];
  created_at: string;
  state?: "starting" | "running" | "failed" | "unknown";
  /** Last time the api-server saw a heartbeat on
   *  `fnvr.state.camera.<id>`. Null means the tracker has never heard
   *  from this camera; a non-null value with state="unknown" indicates
   *  a stale heartbeat (previously running, now gone quiet). */
  last_heartbeat_at?: string | null;
};

export type ClassMutes = {
  global: string[];
  indoor: string[];
  outdoor: string[];
};

export type LocalDevice = { path: string; label: string; capabilities: string[] };

export type DriftStatus = {
  baseline: number | null;
  last_check_at: string | null;
  last_current: number | null;
  last_delta: number | null;
  last_status: string;
  threshold: number;
};

export type SystemStorage = {
  disk: {
    path: string;
    total_bytes: number;
    free_bytes: number;
    free_pct: number;
  };
  min_free_pct: number;
  cameras: Array<{
    id: string;
    name: string;
    retention_days: number;
    quota_gb: number;
    bytes_used: number;
    oldest_segment: string | null;
    newest_segment: string | null;
    segment_count: number;
    gb_per_day: number;
    days_of_headroom: number | null;
  }>;
};

export type Zone = {
  id: string;
  camera_id: string;
  name: string;
  kind: "polygon" | "line" | "tripwire";
  geometry: { points: number[] };
  exclude_classes: string[];
  exclude_kinds: string[];
  created_at: string;
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  definition: {
    /** Omitted/"single" = original per-detection rule. "sequence" = cross-camera chain. */
    kind?: "sequence";
    camera_id?: string;
    classes: string[];
    min_confidence: number;
    zone_id?: string;
    /** For line/tripwire zones: "in" | "out" | "" for both. */
    direction?: "in" | "out" | "";
    cooldown_sec: number;
    severity: "info" | "warning" | "critical";
    schedule?: { start_minute: number; end_minute: number; days: number[]; timezone?: string };
    /** Sequence-rule fields (kind=="sequence" only). */
    steps?: Array<{
      camera_id: string;
      classes?: string[];
      min_confidence?: number;
    }>;
    window_sec?: number;
  };
  created_at: string;
  updated_at: string;
};

export type Incident = {
  id: string;
  rule_id: string | null;
  /** null for system-scope incidents (e.g. ML drift alerts). */
  camera_id: string | null;
  started_at: string;
  ended_at: string | null;
  severity: "info" | "warning" | "critical";
  summary: string;
  acknowledged: boolean;
};

export type Segment = {
  id: number;
  camera_id: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  bytes?: number;
  codec: string;
  protected: boolean;
  tier: "hot" | "warm" | "cold";
};

export type HistoricDetection = {
  id: number;
  event_id: string;
  camera_id: string;
  ts: string;
  class_name: string;
  /** "object" | "anpr" | "face". Absent on older rows (treat as "object"). */
  kind?: "object" | "anpr" | "face";
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  track_id?: string;
  attributes?: Record<string, string>;
};

export type Me = {
  user_id: string;
  username: string;
  role: string;
  is_admin: boolean;
  api_only: boolean;
};

export type User = {
  id: string;
  username: string;
  role: string;
  disabled: boolean;
  api_only: boolean;
  created_at: string;
  updated_at: string;
};

export type APIToken = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
};

export const api = {
  systemInfo: () => req<{ version: string; milestone: string; time: string }>("/system/info"),
  me: () => req<Me>("/me"),

  listLocalDevices: () => req<LocalDevice[]>("/system/local-devices"),

  // Users + tokens (admin only).
  listUsers: () => req<User[]>("/users"),
  createUser: (body: { username: string; password?: string; role: "admin" | "viewer"; api_only?: boolean }) =>
    req<User>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, body: { role?: "admin" | "viewer"; disabled?: boolean; password?: string }) =>
    req<void>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteUser: (id: string) =>
    req<void>(`/users/${id}`, { method: "DELETE" }),
  listTokens: (userID: string) => req<APIToken[]>(`/users/${userID}/tokens`),
  createToken: (userID: string, name: string) =>
    req<{ id: string; token: string }>(`/users/${userID}/tokens`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  revokeToken: (userID: string, tokenID: string) =>
    req<void>(`/users/${userID}/tokens/${tokenID}`, { method: "DELETE" }),

  listCameras: () => req<Camera[]>("/cameras"),
  createCamera: (c: Partial<Camera>) =>
    req<Camera>("/cameras", { method: "POST", body: JSON.stringify(c) }),
  deleteCamera: (id: string) =>
    req<void>(`/cameras/${id}`, { method: "DELETE" }),
  updateCameraDetectors: (id: string, body: { enabled_detectors: string[] }) =>
    req<void>(`/cameras/${id}/detectors`, { method: "PATCH", body: JSON.stringify(body) }),
  updateCameraClasses: (
    id: string,
    body: {
      location_kind?: "indoor" | "outdoor" | "";
      mute_classes_override?: string[];
      unmute_classes_override?: string[];
    },
  ) => req<void>(`/cameras/${id}/classes`, { method: "PATCH", body: JSON.stringify(body) }),
  updateCameraStorage: (
    id: string,
    body: { retention_days?: number; quota_gb?: number },
  ) => req<void>(`/cameras/${id}/storage`, { method: "PATCH", body: JSON.stringify(body) }),
  systemStorage: () => req<SystemStorage>("/system/storage"),

  listZones: (cameraId?: string) =>
    req<Zone[]>(`/zones${cameraId ? `?camera_id=${encodeURIComponent(cameraId)}` : ""}`),
  createZone: (z: Partial<Zone>) =>
    req<Zone>("/zones", { method: "POST", body: JSON.stringify(z) }),
  deleteZone: (id: string) =>
    req<void>(`/zones/${id}`, { method: "DELETE" }),
  updateZoneExclusions: (id: string, body: { exclude_classes: string[]; exclude_kinds: string[] }) =>
    req<void>(`/zones/${id}/exclusions`, { method: "PATCH", body: JSON.stringify(body) }),

  listRules: () => req<Rule[]>("/rules"),
  createRule: (r: Partial<Rule>) =>
    req<Rule>("/rules", { method: "POST", body: JSON.stringify(r) }),
  deleteRule: (id: string) =>
    req<void>(`/rules/${id}`, { method: "DELETE" }),
  enableRule: (id: string) =>
    req<void>(`/rules/${id}/enable`, { method: "POST" }),
  disableRule: (id: string) =>
    req<void>(`/rules/${id}/disable`, { method: "POST" }),

  listIncidents: (limit = 100) => req<Incident[]>(`/incidents?limit=${limit}`),
  ackIncident: (id: string) =>
    req<void>(`/incidents/${id}/ack`, { method: "POST" }),
  deleteIncident: (id: string) =>
    req<void>(`/incidents/${id}`, { method: "DELETE" }),

  listSegments: (opts: { cameraId?: string; from?: Date; to?: Date; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.cameraId) p.set("camera_id", opts.cameraId);
    if (opts.from) p.set("from", opts.from.toISOString());
    if (opts.to) p.set("to", opts.to.toISOString());
    if (opts.limit) p.set("limit", String(opts.limit));
    return req<Segment[]>(`/segments${p.size ? `?${p}` : ""}`);
  },
  segmentFileUrl: (id: number) => `${base}/segments/${id}/file`,

  listDetectionsHistoric: (opts: { cameraId?: string; from?: Date; to?: Date; limit?: number; kind?: string; plate?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.cameraId) p.set("camera_id", opts.cameraId);
    if (opts.from) p.set("from", opts.from.toISOString());
    if (opts.to) p.set("to", opts.to.toISOString());
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.kind) p.set("kind", opts.kind);
    if (opts.plate) p.set("plate", opts.plate);
    return req<HistoricDetection[]>(`/detections${p.size ? `?${p}` : ""}`);
  },

  listHotlist: () => req<HotlistEntry[]>("/plate_hotlist"),
  createHotlist: (body: Partial<HotlistEntry>) =>
    req<HotlistEntry>("/plate_hotlist", { method: "POST", body: JSON.stringify(body) }),
  updateHotlist: (id: string, body: Partial<HotlistEntry>) =>
    req<void>(`/plate_hotlist/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteHotlist: (id: string) =>
    req<void>(`/plate_hotlist/${id}`, { method: "DELETE" }),
  recentPlates: (opts: { hours?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.hours) p.set("hours", String(opts.hours));
    if (opts.limit) p.set("limit", String(opts.limit));
    return req<RecentPlate[]>(`/plates/recent${p.size ? `?${p}` : ""}`);
  },

  listChannels: () => req<NotificationChannel[]>("/notifications/channels"),
  createChannel: (c: Partial<NotificationChannel>) =>
    req<NotificationChannel>("/notifications/channels", { method: "POST", body: JSON.stringify(c) }),
  deleteChannel: (id: string) =>
    req<void>(`/notifications/channels/${id}`, { method: "DELETE" }),
  enableChannel: (id: string) =>
    req<void>(`/notifications/channels/${id}/enable`, { method: "POST" }),
  disableChannel: (id: string) =>
    req<void>(`/notifications/channels/${id}/disable`, { method: "POST" }),

  listSubscriptions: (channelId?: string) =>
    req<NotificationSubscription[]>(`/notifications/subscriptions${channelId ? `?channel_id=${encodeURIComponent(channelId)}` : ""}`),
  createSubscription: (s: Partial<NotificationSubscription>) =>
    req<NotificationSubscription>("/notifications/subscriptions", { method: "POST", body: JSON.stringify(s) }),
  deleteSubscription: (id: string) =>
    req<void>(`/notifications/subscriptions/${id}`, { method: "DELETE" }),

  recentDeliveries: (limit = 50) =>
    req<NotificationDelivery[]>(`/notifications/deliveries?limit=${limit}`),

  // Primary detector settings (YOLO26 variant + precision).
  getDetectorSettings: () => req<DetectorSettings>("/settings/detector"),
  updateDetectorSettings: (body: DetectorSettings) =>
    req<void>("/settings/detector", { method: "PUT", body: JSON.stringify(body) }),

  // INT8 calibration workflow for yolo26 (admin-only trigger).
  getCalibrationStatus: () => req<CalibrationStatus>("/settings/detector/calibration"),
  prepareCalibration: () =>
    req<void>("/settings/detector/prepare_calibration", { method: "POST" }),

  // Class-mute hierarchy (global + indoor/outdoor buckets).
  getClassMutes: () => req<ClassMutes>("/settings/class_mutes"),
  updateClassMutes: (body: ClassMutes) =>
    req<void>("/settings/class_mutes", { method: "PUT", body: JSON.stringify(body) }),

  // Home Assistant bridge config. Password reads back masked; submit
  // the masked string to keep the stored value.
  getHAConfig: () => req<HAConfig>("/settings/ha"),
  updateHAConfig: (body: HAConfig) =>
    req<void>("/settings/ha", { method: "PUT", body: JSON.stringify(body) }),

  // Face ID: persons CRUD + recent-faces view for enrolment.
  listPersons: () => req<Person[]>("/persons"),
  createPerson: (body: Partial<Person>) =>
    req<Person>("/persons", { method: "POST", body: JSON.stringify(body) }),
  updatePerson: (id: string, body: Partial<Person>) =>
    req<void>(`/persons/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  // Erasure flow: cascades to embeddings, matched detection rows,
  // cached thumbnails, and writes an audit row. Returns the counts
  // so the UI can show the operator the scope of what happened.
  deletePerson: (id: string) =>
    req<ErasureReport>(`/persons/${id}`, { method: "DELETE" }),

  // Photo-upload enrolment. Accepts a single-face JPEG/PNG; on
  // multi-face photos the server replies 409 with the list of
  // faces so the client can pick one via face_index.
  uploadEnrol: (
    file: File,
    opts: { person_id?: string; new_label?: string; face_index?: number },
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.person_id) fd.append("person_id", opts.person_id);
    if (opts.new_label) fd.append("new_label", opts.new_label);
    if (opts.face_index !== undefined) fd.append("face_index", String(opts.face_index));
    // req() sets Content-Type:application/json which breaks
    // multipart boundary detection; go via fetch directly.
    return fetch(`${base}/persons/upload_enrol`, {
      method: "POST",
      credentials: "include",
      body: fd,
    }).then(async (res) => {
      if (res.status === 401) {
        if (typeof window !== "undefined" && !window.location.pathname.endsWith("/login")) {
          window.location.href = "/login";
        }
        throw new ApiError(401, "unauthorized");
      }
      if (res.status === 409) {
        // Multi-face disambiguation payload.
        const body = await res.json();
        throw new ApiError(409, JSON.stringify(body));
      }
      if (!res.ok) {
        const body = await res.text();
        throw new ApiError(res.status, body || `${res.status} ${res.statusText}`);
      }
      return res.json();
    });
  },

  // Unknown-face clusters.
  clustersList: (unenrolledOnly = true) =>
    req<Cluster[]>(
      `/clusters${unenrolledOnly ? "?unenrolled=true" : ""}`,
    ),
  clusterMembers: (id: string) =>
    req<ClusterMember[]>(`/clusters/${id}/members`),
  clusterRunNow: () =>
    req<void>(`/clusters/run_now`, { method: "POST" }),
  clusterStatus: () =>
    req<{ last_run_state: unknown }>(`/clusters/status`),
  driftStatus: () => req<DriftStatus>(`/ml/drift/status`),
  clusterEnrol: (
    id: string,
    body: { person_id?: string; new_label?: string },
  ) =>
    req<{ added: number; person_id: string }>(`/clusters/${id}/enrol`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  clusterDismissNotAFace: (id: string) =>
    req<{ dismissed: number }>(`/clusters/${id}/dismiss_not_a_face`, {
      method: "POST",
    }),
  clusterDelete: (id: string) =>
    req<void>(`/clusters/${id}`, { method: "DELETE" }),
  listPersonEmbeddings: (id: string) =>
    req<PersonEmbedding[]>(`/persons/${id}/embeddings`),
  deletePersonEmbedding: (personID: string, embeddingID: string) =>
    req<void>(`/persons/${personID}/embeddings/${embeddingID}`, {
      method: "DELETE",
    }),
  bulkDeletePersonEmbeddings: (personID: string, ids: string[]) =>
    req<{ deleted: number }>(
      `/persons/${personID}/embeddings/delete_bulk`,
      { method: "POST", body: JSON.stringify({ ids }) },
    ),
  addPersonEmbedding: (
    id: string,
    vector: number[],
    source: string,
    detectionID?: number,
  ) =>
    req<{ id: string; person_id: string; source: string; created_at: string }>(
      `/persons/${id}/embeddings`,
      {
        method: "POST",
        body: JSON.stringify({
          vector,
          source,
          detection_id: detectionID ?? 0,
        }),
      },
    ),
  addPersonEmbeddingsBulk: (
    id: string,
    items: Array<{ vector: number[]; source: string; detection_id?: number }>,
  ) =>
    req<{ added: number }>(`/persons/${id}/embeddings_bulk`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  recentFaces: (
    opts: { hours?: number; limit?: number; unmatched?: boolean; collapse?: boolean } = {},
  ) => {
    const p = new URLSearchParams();
    if (opts.hours) p.set("hours", String(opts.hours));
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.unmatched) p.set("unmatched", "true");
    if (opts.collapse) p.set("collapse", "true");
    return req<RecentFace[]>(`/faces/recent${p.size ? `?${p}` : ""}`);
  },
  dismissFaces: (
    items: Array<{
      detection_id: number;
      vector: number[];
      reason: "not_a_face" | "duplicate" | "deleted" | "enrolled";
    }>,
  ) =>
    req<{ dismissed: number }>(`/faces/dismiss`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  personMatches: (id: string, opts: { hours?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.hours) p.set("hours", String(opts.hours));
    if (opts.limit) p.set("limit", String(opts.limit));
    return req<RecentFace[]>(`/persons/${id}/matches${p.size ? `?${p}` : ""}`);
  },

  // Pipeline lifecycle.
  getPipelineState: () => req<PipelineStateResponse>("/system/pipeline/state"),
  restartPipeline: () =>
    req<void>("/system/pipeline/restart", { method: "POST" }),
};

export type DetectorSettings = {
  yolo26_variant: "yolo26n" | "yolo26s" | "yolo26m" | "yolo26l" | "yolo26x";
  yolo26_precision: "fp16" | "int8";
  anpr_enabled?: boolean;
  face_id_enabled?: boolean;
};

// Current INT8 calibration state. image_count reflects the on-disk
// sampler output; last_run / last_error come from the pipeline
// entrypoint's POST to /internal/detector/calibration_report after
// each trtexec attempt. engine_size + table_sha256 are populated on
// success.
export type CalibrationStatus = {
  image_count: number;
  last_run?: string;
  last_error?: string;
  engine_size?: number;
  table_sha256?: string;
};

export type Person = {
  id: string;
  label: string;
  notes?: string;
  enabled: boolean;
  alert_on_match: boolean;
  embedding_count: number;
  created_at: string;
  updated_at: string;
};

// One enrolled embedding for a person. The 512-d vector itself is
// never returned by the list endpoint (it's ~2KB × N rows and the UI
// doesn't need it); `source` identifies where the embedding came from
// (e.g. "enrol-live-{detection_id}" or "enrol-cluster-{detection_id}").
// `detection_id` is the PG id of the detection the embedding was
// enrolled from, populated for all post-0017 rows; the UI uses it to
// render the face thumbnail next to each embedding.
export type PersonEmbedding = {
  id: string;
  person_id: string;
  source: string;
  created_at: string;
  detection_id?: number;
  /** Mean cosine similarity to the 3 NEAREST neighbours in the same
   *  person's pool. Unlike a whole-pool mean, this stays high for
   *  legitimate pose/lighting variants as long as a few similar
   *  siblings exist, and drops for true outliers that have no kin
   *  anywhere in the pool. 0 when the pool has fewer than 2 rows. */
  nearest_neighbour_similarity: number;
};

// Returned by DELETE /persons/{id}: summary of the right-to-erasure
// cascade for display in a confirmation banner.
export type ErasureReport = {
  person_id: string;
  label: string;
  erased_at: string;
  thumbs_removed: number;
  detections_nulled: number;
  embeddings_removed: number;
};

// One row of face_clusters, shaped for the review grid.
export type Cluster = {
  id: string;
  member_count: number;
  representative_detection_id?: number;
  representative_thumbnail_url?: string;
  algorithm: string;
  created_at: string;
  updated_at: string;
  enrolled_person_id?: string;
  first_seen?: string;
  last_seen?: string;
};

// One member of a cluster. The UI renders via thumbnail_url which
// goes through the existing /faces/thumbnail endpoint.
export type ClusterMember = {
  cluster_id: string;
  detection_id: number;
  similarity_to_centroid: number;
  added_at: string;
  thumbnail_url: string;
};

export type RecentFace = {
  detection_id: number;
  event_id: string;
  camera_id: string;
  ts: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  person?: string;
  similarity?: number;
  vector?: number[];
  thumbnail_url: string;
  // Populated when /faces/recent was called with collapse=true. Members
  // are other detection_ids in the same near-duplicate cluster; the
  // representative tile's detection_id is NOT repeated here.
  members?: number[];
  member_vectors?: number[][];
  count?: number;
};

export type HotlistEntry = {
  id: string;
  pattern: string;
  label: string;
  severity: "info" | "warning" | "critical";
  notes?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type RecentPlate = {
  plate: string;
  last_camera: string;
  last_seen: string;
  count: number;
};

export type HAConfig = {
  enabled: boolean;
  broker_url: string;
  username: string;
  /** Returned masked from GET; submit unchanged to keep stored value. */
  password: string;
  discovery_prefix: string;
  topic_prefix: string;
};

export type PipelineState = {
  state: "unknown" | "calibrating" | "compiling_engine" | "ready" | "failed" | string;
  variant?: string;
  precision?: string;
  message?: string;
  stamped?: string;
};

export type PipelineStateResponse = {
  known: boolean;
  state: PipelineState;
};

export type NotificationChannel = {
  id: string;
  name: string;
  kind: "webhook" | "ntfy" | "mqtt";
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type NotificationSubscription = {
  id: string;
  channel_id: string;
  rule_id?: string;
  camera_id?: string;
  min_severity: "info" | "warning" | "critical";
};

export type NotificationDelivery = {
  id: number;
  incident_id: string;
  channel_id: string;
  attempted_at: string;
  succeeded: boolean;
  status_code?: number;
  error?: string;
};
