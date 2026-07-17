import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";

// Promise-based confirm so replacing window.confirm is mechanical:
//   const confirm = useConfirm();
//   if (!(await confirm({ title: "Delete channel?", tone: "danger" }))) return;

export type ConfirmOpts = {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string; // default "Confirm"
  cancelLabel?: string; // default "Cancel"
  tone?: "default" | "danger"; // danger → red confirm button
};

type Pending = ConfirmOpts & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((opts: ConfirmOpts) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((opts: ConfirmOpts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pending) cancelRef.current?.focus();
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={pending !== null} onClose={() => settle(false)} ariaLabel={pending?.title ?? "Confirm"}>
        {pending && (
          <div className="space-y-3">
            <h3 className="text-base font-semibold">{pending.title}</h3>
            {pending.body && <div className="text-sm text-neutral-400">{pending.body}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                ref={cancelRef}
                type="button"
                className="text-sm px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={`text-sm px-3 py-1.5 rounded text-white ${
                  pending.tone === "danger"
                    ? "bg-red-700 hover:bg-red-600"
                    : "bg-blue-600 hover:bg-blue-500"
                }`}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOpts) => Promise<boolean> {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return confirm;
}
