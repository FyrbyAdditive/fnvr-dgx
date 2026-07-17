// Shared section chrome for settings-style pages. One consistent look
// instead of the previous mix of bare <section>s and ad-hoc borders.
export function Card({
  title,
  description,
  headerRight,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-neutral-900/60 border border-neutral-800 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="text-sm text-neutral-500 mt-0.5">{description}</p>}
        </div>
        {headerRight && <div className="shrink-0">{headerRight}</div>}
      </div>
      {children}
    </section>
  );
}

export function FormRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[11rem_1fr] items-center gap-x-2 gap-y-0.5 text-sm">
      <label htmlFor={htmlFor} className="text-neutral-400">
        {label}
      </label>
      <div>{children}</div>
      {hint && (
        <>
          <span />
          <p className="text-xs text-neutral-500">{hint}</p>
        </>
      )}
    </div>
  );
}

export function SaveBar({
  dirty,
  saving,
  saveLabel = "Save",
  onSave,
  onDiscard,
  error,
  disabled,
}: {
  dirty: boolean;
  saving: boolean;
  saveLabel?: string;
  onSave: () => void;
  onDiscard: () => void;
  error?: string;
  /** Extra gate (e.g. failed client-side validation) that blocks Save
   *  while still showing the bar. */
  disabled?: boolean;
}) {
  if (!dirty) return null;
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-xs text-amber-400">Unsaved changes</span>
      <button
        type="button"
        className="text-sm px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white"
        onClick={onDiscard}
        disabled={saving}
      >
        Discard
      </button>
      <button
        type="button"
        className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
        onClick={onSave}
        disabled={saving || disabled}
      >
        {saving ? "Saving…" : saveLabel}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
