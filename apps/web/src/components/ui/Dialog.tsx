import { useEffect } from "react";

// Small modal shell generalizing EnlargedCameraModal's pattern:
// dimmed backdrop, click-outside + Esc to close, body scroll lock.
export function Dialog({
  open,
  onClose,
  ariaLabel,
  children,
  panelClassName,
  panelRef,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
  /** Override the panel chrome (e.g. a video modal wants a large black
   *  panel). Defaults to the standard small settings-dialog look. */
  panelClassName?: string;
  panelRef?: React.Ref<HTMLDivElement>;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className={
          panelClassName ??
          "bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[min(92vw,28rem)] p-4"
        }
      >
        {children}
      </div>
    </div>
  );
}
