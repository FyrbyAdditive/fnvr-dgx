import { useEffect, useRef, useState } from "react";

// deepEqual: structural compare for plain JSON-ish values (objects,
// arrays, primitives). Array order matters — callers whose arrays are
// semantically sets should pass a custom isEqual.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

// reseed decides what the draft becomes when fresh server data lands:
// follow the server while the user has no local edits (draft still
// equals whatever it was last seeded from), keep their edits otherwise.
// Pure so the seeding policy is unit-testable without rendering.
export function reseed<T>(
  cur: T | undefined,
  lastSeeded: T | undefined,
  server: T,
  isEqual: (a: T, b: T) => boolean,
): T {
  const clean = cur === undefined || (lastSeeded !== undefined && isEqual(cur, lastSeeded));
  return clean ? server : (cur as T);
}

/**
 * The standard draft/dirty pattern for settings cards.
 *
 * - Seeds the draft when server data first arrives.
 * - Re-seeds when the server value changes AND the draft has no local
 *   edits (draft still equals the value it was last seeded from) — so
 *   a refetch, or another tab's save, refreshes the form instead of
 *   silently diverging, but never stomps in-progress edits.
 * - `dirty` compares draft vs server; `discard()` resets to server.
 */
export function useDraft<T>(
  server: T | undefined,
  isEqual: (a: T, b: T) => boolean = deepEqual,
): {
  draft: T | undefined;
  setDraft: React.Dispatch<React.SetStateAction<T | undefined>>;
  dirty: boolean;
  discard: () => void;
} {
  const [draft, setDraft] = useState<T | undefined>(undefined);
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const lastSeeded = useRef<T | undefined>(undefined);

  useEffect(() => {
    if (server === undefined) return;
    setDraft((cur) => reseed(cur, lastSeeded.current, server, isEqualRef.current));
    lastSeeded.current = server;
  }, [server]);

  const dirty = draft !== undefined && server !== undefined && !isEqualRef.current(draft, server);

  return {
    draft,
    setDraft,
    dirty,
    discard: () => setDraft(server),
  };
}
