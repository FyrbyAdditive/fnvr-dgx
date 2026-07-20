// Incident severity colouring — single source of truth shared by the
// Timeline rulers, the events digest and the Events page.

export type Severity = "critical" | "warning" | "info";

/** Background classes for span/marker fills (rulers). */
export const SEVERITY_BG: Record<Severity, string> = {
  critical: "bg-red-500/70 hover:bg-red-400/80",
  warning: "bg-amber-400/70 hover:bg-amber-300/80",
  info: "bg-blue-400/70 hover:bg-blue-300/80",
};

/** Text classes for severity dots / labels (lists, hover cards). */
export const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-red-400",
  warning: "text-amber-400",
  info: "text-blue-400",
};

export function severityBg(s: string): string {
  return SEVERITY_BG[s as Severity] ?? SEVERITY_BG.info;
}

export function severityColor(s: string): string {
  return SEVERITY_TEXT[s as Severity] ?? SEVERITY_TEXT.info;
}
