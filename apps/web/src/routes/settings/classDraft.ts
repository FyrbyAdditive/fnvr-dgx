import { ClassMutes } from "@/lib/api";

// Draft model for the unified classes table. Diff-only override maps —
// a key exists only while the user's choice differs from the server.
// That makes "N unsaved changes" a simple count, lets server refetches
// merge cleanly under in-progress edits, and (crucially) means
// applyMutes never drops mute slugs the table doesn't render (e.g.
// mutes of taxonomy-disabled classes).

export type MuteBucket = "global" | "indoor" | "outdoor";

export type ClassDraft = {
  /** detection_classes.id → desired enabled, only where ≠ server */
  taxonomy: Record<number, boolean>;
  /** bucket → slug → desired muted, only where ≠ server */
  mutes: Record<MuteBucket, Record<string, boolean>>;
};

export const emptyDraft = (): ClassDraft => ({
  taxonomy: {},
  mutes: { global: {}, indoor: {}, outdoor: {} },
});

export function toggleTaxonomy(
  d: ClassDraft,
  id: number,
  next: boolean,
  serverVal: boolean,
): ClassDraft {
  const taxonomy = { ...d.taxonomy };
  if (next === serverVal) delete taxonomy[id];
  else taxonomy[id] = next;
  return { ...d, taxonomy };
}

export function toggleMute(
  d: ClassDraft,
  bucket: MuteBucket,
  slug: string,
  next: boolean,
  serverMuted: boolean,
): ClassDraft {
  const b = { ...d.mutes[bucket] };
  if (next === serverMuted) delete b[slug];
  else b[slug] = next;
  return { ...d, mutes: { ...d.mutes, [bucket]: b } };
}

export function countChanges(d: ClassDraft): number {
  return (
    Object.keys(d.taxonomy).length +
    Object.keys(d.mutes.global).length +
    Object.keys(d.mutes.indoor).length +
    Object.keys(d.mutes.outdoor).length
  );
}

export function taxonomyChanges(d: ClassDraft): { id: number; enabled: boolean }[] {
  return Object.entries(d.taxonomy).map(([id, enabled]) => ({ id: Number(id), enabled }));
}

// applyMutes starts from the server's full lists and applies only the
// diffs, so slugs outside the rendered table survive untouched.
export function applyMutes(server: ClassMutes, d: ClassDraft): ClassMutes {
  const apply = (list: string[], diffs: Record<string, boolean>): string[] => {
    const set = new Set(list);
    for (const [slug, muted] of Object.entries(diffs)) {
      if (muted) set.add(slug);
      else set.delete(slug);
    }
    return Array.from(set).sort();
  };
  return {
    global: apply(server.global, d.mutes.global),
    indoor: apply(server.indoor, d.mutes.indoor),
    outdoor: apply(server.outdoor, d.mutes.outdoor),
  };
}
