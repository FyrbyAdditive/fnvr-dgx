import { createContext, useCallback, useContext, useRef, useState } from "react";

// Minimal toast system: success/info auto-dismiss in 4s, errors linger
// 8s and always carry a dismiss button. Mutations across the app were
// previously silent on success — every save/delete should now toast.

type ToastKind = "success" | "error" | "info";

type ToastOpts = {
  action?: { label: string; onClick: () => void };
};

type ToastAPI = {
  success: (msg: string, opts?: ToastOpts) => void;
  error: (msg: string, opts?: ToastOpts) => void;
  info: (msg: string, opts?: ToastOpts) => void;
};

type ToastItem = {
  id: number;
  kind: ToastKind;
  msg: string;
  action?: ToastOpts["action"];
};

const ToastContext = createContext<ToastAPI | null>(null);

const KIND_STYLE: Record<ToastKind, string> = {
  success: "bg-emerald-900/90 border-emerald-700 text-emerald-100",
  error: "bg-red-950/90 border-red-800 text-red-100",
  info: "bg-neutral-800/95 border-neutral-700 text-neutral-200",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, msg: string, opts?: ToastOpts) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts, { id, kind, msg, action: opts?.action }]);
      setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000);
    },
    [dismiss],
  );

  const apiRef = useRef<ToastAPI>({
    success: (m, o) => push("success", m, o),
    error: (m, o) => push("error", m, o),
    info: (m, o) => push("info", m, o),
  });
  // push is stable (useCallback with stable dep), so the API object
  // never changes identity — consumers don't re-render on toasts.
  apiRef.current.success = (m, o) => push("success", m, o);
  apiRef.current.error = (m, o) => push("error", m, o);
  apiRef.current.info = (m, o) => push("info", m, o);

  return (
    <ToastContext.Provider value={apiRef.current}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`border rounded px-3 py-2 text-sm shadow-lg flex items-start gap-2 ${KIND_STYLE[t.kind]}`}
          >
            <span className="flex-1">{t.msg}</span>
            {t.action && (
              <button
                type="button"
                className="underline hover:no-underline whitespace-nowrap"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.kind === "error" && (
              <button
                type="button"
                aria-label="Dismiss"
                className="text-red-300 hover:text-white"
                onClick={() => dismiss(t.id)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastAPI {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
