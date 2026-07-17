import type { ClusterRunState, RecentFace } from "@/lib/api";

// Pure helpers for the Faces review queue — vitest-covered.

export type DismissReason = "not_a_face" | "duplicate" | "deleted" | "enrolled";

// buildDismissItems flattens the selected representative tiles plus
// their collapsed near-duplicate members into /faces/dismiss items.
// (The API round-trips full vectors by contract — the server trains
// negatives from them for not_a_face/duplicate.)
export function buildDismissItems(
  faces: RecentFace[],
  selected: Set<number>,
  reason: DismissReason,
): Array<{ detection_id: number; vector: number[]; reason: DismissReason }> {
  const items: Array<{ detection_id: number; vector: number[]; reason: DismissReason }> = [];
  for (const f of faces) {
    if (!selected.has(f.detection_id) || !f.vector) continue;
    items.push({ detection_id: f.detection_id, vector: f.vector, reason });
    if (f.member_vectors && f.members) {
      f.member_vectors.forEach((v, i) => {
        items.push({ detection_id: f.members![i], vector: v, reason });
      });
    }
  }
  return items;
}

// buildEnrolVectors flattens the selected tiles into embeddings_bulk
// items, sourcing each from its detection so thumbnails resolve.
export function buildEnrolVectors(
  faces: RecentFace[],
  selected: Set<number>,
): Array<{ vector: number[]; source: string; detection_id?: number }> {
  const out: Array<{ vector: number[]; source: string; detection_id?: number }> = [];
  for (const f of faces) {
    if (!selected.has(f.detection_id) || !f.vector) continue;
    out.push({
      vector: f.vector,
      source: `enrol-live-${f.detection_id}`,
      detection_id: f.detection_id,
    });
    if (f.member_vectors && f.members) {
      f.member_vectors.forEach((v, i) => {
        out.push({
          vector: v,
          source: `enrol-cluster-${f.members![i]}`,
          detection_id: f.members![i],
        });
      });
    }
  }
  return out;
}

// Pagination ladder for the review grid ("show more").
export function nextLimit(current: number): number {
  return Math.min(480, current + 120);
}

// enrolToastMessage renders the outcome of an enrol action. The server
// diversity-prunes batches (near-duplicates of the person's existing
// pool or of each other are skipped), so "selected 23, enrolled 5" is
// normal and the message must say why.
export function enrolToastMessage(res: {
  added: number;
  skipped_near_duplicates?: number;
  retro_matched?: number;
}): string {
  const skipped = res.skipped_near_duplicates ?? 0;
  const retro = res.retro_matched ?? 0;
  let msg: string;
  if (res.added > 0) {
    msg = `Enrolled ${res.added} face sample${res.added === 1 ? "" : "s"}`;
    if (skipped > 0) msg += ` · ${skipped} near-duplicate${skipped === 1 ? "" : "s"} skipped`;
  } else if (skipped > 0) {
    msg = `No new samples — all ${skipped} were near-duplicates of the existing enrolment`;
  } else {
    msg = "No samples enrolled";
  }
  if (retro > 0) {
    msg += ` · ${retro} earlier sighting${retro === 1 ? "" : "s"} auto-matched`;
  }
  return msg;
}

// Defensive parse of the loosely-typed cluster-status payload.
export function parseClusterRunState(u: unknown): ClusterRunState | null {
  if (!u || typeof u !== "object") return null;
  const s = (u as { state?: unknown }).state;
  if (s !== "running" && s !== "ok" && s !== "error") return null;
  return u as ClusterRunState;
}
