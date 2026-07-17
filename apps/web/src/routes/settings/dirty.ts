import { createContext, useContext, useEffect } from "react";

// Cards report their dirty state up to the Settings shell so a tab
// switch can warn about unsaved changes. Default no-op context keeps
// cards usable outside the shell (tests, storybook-style probing).
export const SettingsDirtyContext = createContext<{
  report: (id: string, dirty: boolean) => void;
  anyDirty: () => boolean;
}>({ report: () => {}, anyDirty: () => false });

export function useReportDirty(id: string, dirty: boolean) {
  const { report } = useContext(SettingsDirtyContext);
  useEffect(() => {
    report(id, dirty);
    return () => report(id, false); // unmount clears the flag
  }, [id, dirty, report]);
}
