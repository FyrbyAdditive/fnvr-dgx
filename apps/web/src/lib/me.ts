import { useQuery } from "@tanstack/react-query";
import { api, Me } from "./api";

// useMe returns the current authenticated user. Components that gate
// UI on role read `is_admin` — the server is authoritative for the
// actual 403; this is a UX hint so viewers don't see buttons that
// would return a forbidden.
export function useMe() {
  return useQuery<Me>({
    queryKey: ["me"],
    queryFn: api.me,
    // Refresh hourly so a role change eventually lands without a hard
    // reload, but not so often we spam /me.
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

export function isAdmin(me?: Me | null): boolean {
  return !!me?.is_admin;
}
