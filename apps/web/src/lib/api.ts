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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
};

export type ClassMutes = {
  global: string[];
  indoor: string[];
  outdoor: string[];
};

export type LocalDevice = { path: string; label: string; capabilities: string[] };

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
    camera_id?: string;
    classes: string[];
    min_confidence: number;
    zone_id?: string;
    /** For line/tripwire zones: "in" | "out" | "" for both. */
    direction?: "in" | "out" | "";
    cooldown_sec: number;
    severity: "info" | "warning" | "critical";
    schedule?: { start_minute: number; end_minute: number; days: number[]; timezone?: string };
  };
  created_at: string;
  updated_at: string;
};

export type Incident = {
  id: string;
  rule_id: string | null;
  camera_id: string;
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

export const api = {
  systemInfo: () => req<{ version: string; milestone: string; time: string }>("/system/info"),

  listLocalDevices: () => req<LocalDevice[]>("/system/local-devices"),

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

  listSegments: (opts: { cameraId?: string; from?: Date; to?: Date; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.cameraId) p.set("camera_id", opts.cameraId);
    if (opts.from) p.set("from", opts.from.toISOString());
    if (opts.to) p.set("to", opts.to.toISOString());
    if (opts.limit) p.set("limit", String(opts.limit));
    return req<Segment[]>(`/segments${p.size ? `?${p}` : ""}`);
  },
  segmentFileUrl: (id: number) => `${base}/segments/${id}/file`,

  listDetectionsHistoric: (opts: { cameraId?: string; from?: Date; to?: Date; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.cameraId) p.set("camera_id", opts.cameraId);
    if (opts.from) p.set("from", opts.from.toISOString());
    if (opts.to) p.set("to", opts.to.toISOString());
    if (opts.limit) p.set("limit", String(opts.limit));
    return req<HistoricDetection[]>(`/detections${p.size ? `?${p}` : ""}`);
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

  // Class-mute hierarchy (global + indoor/outdoor buckets).
  getClassMutes: () => req<ClassMutes>("/settings/class_mutes"),
  updateClassMutes: (body: ClassMutes) =>
    req<void>("/settings/class_mutes", { method: "PUT", body: JSON.stringify(body) }),

  // Pipeline lifecycle.
  getPipelineState: () => req<PipelineStateResponse>("/system/pipeline/state"),
  restartPipeline: () =>
    req<void>("/system/pipeline/restart", { method: "POST" }),
};

export type DetectorSettings = {
  yolo26_variant: "yolo26n" | "yolo26s" | "yolo26m" | "yolo26l" | "yolo26x";
  yolo26_precision: "fp16" | "int8";
  anpr_enabled?: boolean;
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
  kind: "webhook" | "ntfy";
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
