import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, Person } from "@/lib/api";

// UploadEnrolModal: enrol a person from a photo upload.
//
// Flow:
// 1. Operator picks a file + existing person (or types a new name).
// 2. Client POSTs multipart; server runs RetinaFace+AdaFace via
//    ml-worker.
// 3. On a single-face image the server enrols immediately and
//    returns the embedding row.
// 4. On multiple faces the server replies 409 with the face list;
//    we show thumbnails of the detected faces and let the operator
//    pick the right one, then resubmit with face_index.
export function UploadEnrolModal({
  persons,
  onClose,
  onEnrolled,
}: {
  persons: Person[];
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pickId, setPickId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [faceIndex, setFaceIndex] = useState<number | null>(null);
  const [multiFaces, setMultiFaces] = useState<
    | Array<{ bbox: { x: number; y: number; w: number; h: number }; score: number }>
    | null
  >(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("pick a file first");
      return api.uploadEnrol(file, {
        person_id: pickId || undefined,
        new_label: pickId ? undefined : newLabel.trim() || undefined,
        face_index: faceIndex ?? undefined,
      });
    },
    onSuccess: () => {
      onEnrolled();
    },
    onError: (err) => {
      // Server returns 409 with the full faces[] payload when the
      // photo has multiple faces. Stash and show a picker.
      if (err instanceof ApiError && err.status === 409) {
        try {
          const payload = JSON.parse(err.message);
          if (Array.isArray(payload.faces)) {
            setMultiFaces(payload.faces);
          }
        } catch {
          // ignore — stays in default error-banner mode
        }
      }
    },
  });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-4 max-w-xl w-full space-y-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-lg font-semibold">Upload photo to enrol</h3>
          <button
            className="ml-auto text-neutral-400 hover:underline text-sm"
            onClick={onClose}
          >
            close
          </button>
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Photo (JPEG/PNG, ≤5 MB)</label>
          <input
            type="file"
            accept="image/jpeg,image/png"
            className="text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setFaceIndex(null);
              setMultiFaces(null);
              if (previewUrl) URL.revokeObjectURL(previewUrl);
              setPreviewUrl(f ? URL.createObjectURL(f) : null);
            }}
          />
        </div>

        {previewUrl && (
          <div className="aspect-video bg-neutral-900 flex items-center justify-center overflow-hidden rounded">
            <img src={previewUrl} alt="" className="max-h-48 object-contain" />
          </div>
        )}

        {multiFaces && (
          <div className="text-xs space-y-1">
            <div className="text-amber-400">
              Multiple faces found — pick which one to enrol:
            </div>
            <div className="flex gap-2 flex-wrap">
              {multiFaces.map((f, i) => (
                <button
                  key={i}
                  className={`border rounded px-2 py-1 ${
                    faceIndex === i
                      ? "border-blue-500 bg-blue-950/40"
                      : "border-neutral-700 hover:border-neutral-500"
                  }`}
                  onClick={() => setFaceIndex(i)}
                >
                  #{i} ({(f.score * 100).toFixed(0)}%)
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Person</label>
          <select
            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
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
              className="w-full mt-2 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
              placeholder="new person name"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          )}
        </div>

        <div className="flex gap-2 items-center">
          <button
            className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
            disabled={
              submit.isPending ||
              !file ||
              (!pickId && !newLabel.trim()) ||
              (multiFaces !== null && faceIndex === null)
            }
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "uploading…" : "enrol"}
          </button>
          {submit.isError && !multiFaces && (
            <span className="text-red-400 text-xs">
              {(submit.error as Error).message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
