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
  /** Clockwise software rotation applied by the pipeline. */
  rotation?: 0 | 90 | 180 | 270;
  /** If true, the pipeline pulls this camera via the local MediaMTX
   *  re-muxer instead of the source URL directly. Only surfaced in the
   *  UI for no-AI cameras (enabled_detectors=["none"]). */
  mtx_proxy?: boolean;
  /** SHA256 fingerprint of the upstream's TLS cert (uppercase, colon-
   *  separated). Non-empty = MediaMTX pins to this cert instead of
   *  doing CA validation. Populated automatically when operator ticks
   *  "Ignore certificate" on an RTSPS source. */
  mtx_tls_fingerprint?: string;
  /** Which inference path this camera's primary detector runs on.
   *  "trt" (default) = DeepStream nvinfer on the Orin GPU.
   *  "hailo" = hailonet on the Hailo-8 PCIe accelerator. */
  detector_backend?: "trt" | "hailo";
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
    /** Legacy single-camera target. New rules set camera_ids instead. */
    camera_id?: string;
    /** Multi-camera target subset. Empty + empty camera_id = all cameras. */
    camera_ids?: string[];
    classes: string[];
    min_confidence: number;
    zone_id?: string;
    /** For line/tripwire zones: "in" | "out" | "" for both. */
    direction?: "in" | "out" | "";
    cooldown_sec: number;
    severity: "info" | "warning" | "critical";
    /** Global alarm-state gate. Empty/"any" = fires regardless. */
    active_when?: AlarmStateValue | "any" | "";
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
  /** First rule that opened this incident. For UI display prefer
   *  `rule_ids` (the full set of contributing rules). */
  rule_id: string | null;
  /** null for system-scope incidents (e.g. ML drift alerts). */
  camera_id: string | null;
  started_at: string;
  ended_at: string | null;
  severity: "info" | "warning" | "critical";
  summary: string;
  acknowledged: boolean;
  /** All distinct class names that contributed to this incident
   *  inside its merge window. UI joins with " + " for display. */
  classes: string[];
  /** All distinct rule IDs that contributed. */
  rule_ids: string[];
  /** Wall-clock timestamp of the most recent detection that folded
   *  in. Drives the "last seen" line and the live age indicator. */
  last_detection_at: string;
  /** Total number of detections folded into this incident. Renders
   *  as the "×N" badge. */
  detection_count: number;
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
  enableCamera: (id: string) =>
    req<void>(`/cameras/${id}/enable`, { method: "POST" }),
  disableCamera: (id: string) =>
    req<void>(`/cameras/${id}/disable`, { method: "POST" }),
  updateCameraRotation: (id: string, rotation: 0 | 90 | 180 | 270) =>
    req<void>(`/cameras/${id}/rotation`, {
      method: "PATCH",
      body: JSON.stringify({ rotation }),
    }),
  updateCameraBasics: (id: string, body: { name?: string; url?: string }) =>
    req<void>(`/cameras/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateCameraMtxProxy: (id: string, mtx_proxy: boolean) =>
    req<void>(`/cameras/${id}/mtx_proxy`, {
      method: "PATCH",
      body: JSON.stringify({ mtx_proxy }),
    }),
  updateCameraDetectorBackend: (id: string, backend: "trt" | "hailo") =>
    req<void>(`/cameras/${id}/detector_backend`, {
      method: "PATCH",
      body: JSON.stringify({ backend }),
    }),
  getHailoStatus: () => req<{ present: boolean }>("/system/hailo"),
  updateCameraMtxTLSIgnore: (id: string, ignore: boolean) =>
    req<{ mtx_tls_fingerprint: string }>(
      `/cameras/${id}/mtx_tls_ignore`,
      { method: "PATCH", body: JSON.stringify({ ignore }) },
    ),
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
  updateRule: (id: string, body: { name?: string; definition?: Rule["definition"] }) =>
    req<void>(`/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
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

  // Global alarm state. Rules with active_when fire only when the
  // mode matches; "disarmed" is the default.
  getAlarm: () => req<AlarmStateBody>("/settings/alarm"),
  updateAlarm: (body: AlarmStateBody) =>
    req<void>("/settings/alarm", { method: "PUT", body: JSON.stringify(body) }),

  // Pipeline-supervisor startup grace: seconds after a worker (re)spawn
  // during which transient exits don't publish "failed" to the UI.
  getPipelineStartupGrace: () =>
    req<{ startup_grace_sec: number }>("/settings/pipeline_startup_grace"),
  updatePipelineStartupGrace: (sec: number) =>
    req<void>("/settings/pipeline_startup_grace", {
      method: "PUT",
      body: JSON.stringify({ startup_grace_sec: sec }),
    }),

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

  // Object-detection false-positive / relabel flags. `eventID` is the
  // detection's event_id (short hex string, the one the SSE stream
  // publishes as `id`) — the server resolves it to the PG row id.
  flagDetection: (eventID: string, classCorrected: string | null) =>
    req<ObjectFlag>(`/detections/${eventID}/flag`, {
      method: "POST",
      body: JSON.stringify({ class_corrected: classCorrected }),
    }),
  // Manual flag: the user drew a fresh bbox on a frozen tile (no
  // underlying detection row). bbox values are normalised [0,1] in
  // the tile coordinate system. The class slug must match an enabled
  // row in detection_classes.
  flagManual: (args: {
    camera_id: string;
    bbox: { x: number; y: number; w: number; h: number };
    class: string;
  }) =>
    req<ObjectFlag>("/flags/manual", {
      method: "POST",
      body: JSON.stringify(args),
    }),
  listObjectFlags: (params?: {
    camera_id?: string;
    class_original?: string;
    dismissed?: boolean;
    limit?: number;
  }) => {
    const p = new URLSearchParams();
    if (params?.camera_id) p.set("camera_id", params.camera_id);
    if (params?.class_original) p.set("class_original", params.class_original);
    if (params?.dismissed) p.set("dismissed", "1");
    if (params?.limit) p.set("limit", String(params.limit));
    return req<ObjectFlag[]>(`/object-flags${p.size ? `?${p}` : ""}`);
  },
  dismissObjectFlag: (id: number, purge = false) =>
    req<ObjectFlag>(`/object-flags/${id}${purge ? "?purge=true" : ""}`, {
      method: "DELETE",
    }),
  objectFlagStats: () => req<ObjectFlagStats>("/object-flags/stats"),
};

// yolo26_variant is now an open string: it accepts the 5 stock sizes
// (yolo26n..yolo26x) plus any custom-trained model name like
// "fnvr-v1" produced by tools/train-detector/ --target gpu. The UI
// presents the stock list in a dropdown alongside any fnvr-vN
// values it discovers.
export type DetectorSettings = {
  yolo26_variant: string;
  yolo26_precision: "fp16" | "int8";
  anpr_enabled?: boolean;
  face_id_enabled?: boolean;
  // Hailo HEF version: "stock" loads the pre-compiled
  // yolov11l.hef from Hailo Model Zoo; any other string loads
  // /var/lib/fnvr/models/hailo/<name>.hef (fine-tuned via
  // tools/compile-hef/). Broker resolves at startup with graceful
  // fallback to stock if the file's missing.
  hailo_model_version?: string;
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

export type AlarmStateValue = "home" | "away" | "disarmed";
export type AlarmStateBody = { state: AlarmStateValue };

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

// Object-detection flag. Created when an operator clicks a bounding
// box on the Live view and marks it as a false positive or relabels
// it. Each flag both drives real-time suppression (via event-processor
// pHash matching) AND writes an entry to the YOLO-format dataset tree
// under /var/lib/fnvr/datasets/objects/ for future off-device training.
export type ObjectFlag = {
  id: number;
  detection_id: number;
  camera_id: string;
  ts: string;
  class_original: string;
  class_corrected: string | null;
  bbox: { x: number; y: number; w: number; h: number };
  phash: number;
  frame_path: string;
  label_path: string;
  created_by: string | null;
  created_at: string;
  dismissed_at: string | null;
};

export type ObjectFlagStats = {
  total: number;
  active: number;
  dismissed: number;
  by_camera: Record<string, number>;
  by_class: Record<string, number>;
};

// Detection class taxonomy — server-driven via /admin/classes, backed
// by the detection_classes Postgres table. Fetched once and cached.
// The user manages enabled/disabled + custom additions from the
// Settings → Classes page.
export type DetectionClass = {
  id: number;
  slug: string;
  display_name: string;
  yolo_id: number;
  origin: "coco" | "custom";
  enabled: boolean;
  created_at: string;
};

let _classCache: Promise<DetectionClass[]> | null = null;

// fetchDetectionClasses returns the full list (enabled + disabled).
// Cached per page-load; call invalidateDetectionClasses() after a
// mutation to force a refresh.
export function fetchDetectionClasses(): Promise<DetectionClass[]> {
  if (!_classCache) {
    _classCache = req<DetectionClass[]>("/admin/classes");
  }
  return _classCache;
}

export function invalidateDetectionClasses() {
  _classCache = null;
}

export function createDetectionClass(slug: string, displayName: string) {
  invalidateDetectionClasses();
  return req<DetectionClass>("/admin/classes", {
    method: "POST",
    body: JSON.stringify({ slug, display_name: displayName }),
  });
}

export function patchDetectionClass(
  id: number,
  patch: { enabled?: boolean; display_name?: string },
) {
  invalidateDetectionClasses();
  return req<DetectionClass>(`/admin/classes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteDetectionClass(id: number) {
  invalidateDetectionClasses();
  return req<void>(`/admin/classes/${id}`, { method: "DELETE" });
}

// Legacy alias kept temporarily while callers migrate to the
// server-driven list. Returns the slug strings of every enabled
// class (synthesised from the cached fetch). Most callers should
// switch to fetchDetectionClasses() and read .display_name for UI.
export async function enabledClassSlugs(): Promise<string[]> {
  const cs = await fetchDetectionClasses();
  return cs.filter((c) => c.enabled).map((c) => c.slug);
}
