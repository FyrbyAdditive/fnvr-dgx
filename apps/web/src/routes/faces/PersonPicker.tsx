import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";

// PersonPicker: the one "select an existing person or create a new
// one" dialog, shared by tile enrol, bulk enrol, cluster enrol, and
// photo-upload enrol (which previously each had their own copy of the
// select+input block).
export function PersonPicker({
  open,
  title,
  submitLabel,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  pending: boolean;
  error?: string | null;
  /** personId is "" when the operator chose "create new"; newLabel is
   *  the trimmed name in that case. */
  onSubmit: (personId: string, newLabel: string) => void;
  onClose: () => void;
}) {
  const { data: persons = [] } = useQuery({
    queryKey: ["persons"],
    queryFn: api.listPersons,
    enabled: open,
  });
  const [pickId, setPickId] = useState("");
  const [newLabel, setNewLabel] = useState("");

  return (
    <Dialog open={open} onClose={onClose} ariaLabel={title}>
      <div className="space-y-3">
        <h3 className="text-base font-semibold">{title}</h3>
        <select
          className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm"
          value={pickId}
          onChange={(e) => setPickId(e.target.value)}
        >
          <option value="">— create new person —</option>
          {persons.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {!pickId && (
          <input
            autoFocus
            className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm"
            placeholder="New person's name"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newLabel.trim()) {
                onSubmit("", newLabel.trim());
              }
            }}
          />
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="text-sm px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            disabled={pending || (!pickId && !newLabel.trim())}
            onClick={() => onSubmit(pickId, newLabel.trim())}
          >
            {pending ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
