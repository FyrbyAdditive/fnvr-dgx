import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, APIToken } from "@/lib/api";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

export function TokensPanel({ userID }: { userID: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: tokens = [] } = useQuery({
    queryKey: ["tokens", userID],
    queryFn: () => api.listTokens(userID),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["tokens", userID] });
  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createToken(userID, name.trim()),
    onSuccess: (res) => {
      setJustCreated(res.token);
      setName("");
      invalidate();
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "token create failed")),
  });
  const revoke = useMutation({
    mutationFn: (tokenID: string) => api.revokeToken(userID, tokenID),
    onSuccess: () => {
      invalidate();
      toast.success("Token revoked");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "revoke failed")),
  });

  return (
    <div className="mt-2 ml-3 pl-3 border-l-2 border-neutral-800 space-y-2">
      <form
        className="flex items-center gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <input
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 min-w-[14rem]"
          placeholder="Token name (e.g. grafana, home-assistant)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-500 rounded px-2 py-0.5 disabled:opacity-50"
          disabled={create.isPending}
        >
          {create.isPending ? "creating…" : "create token"}
        </button>
      </form>
      {justCreated && (
        <div className="bg-emerald-950/60 border border-emerald-700 rounded p-2 text-xs">
          <div className="mb-1 text-emerald-200">
            New token — copy now, it will not be shown again.
          </div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 font-mono text-xs"
              value={justCreated}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              className="bg-neutral-800 hover:bg-neutral-700 rounded px-2 py-1"
              onClick={() => {
                navigator.clipboard?.writeText(justCreated);
                toast.info("Token copied to clipboard");
              }}
            >
              copy
            </button>
            <button
              className="text-neutral-400 hover:text-white"
              onClick={() => setJustCreated(null)}
            >
              dismiss
            </button>
          </div>
        </div>
      )}
      {tokens.length === 0 ? (
        <p className="text-xs text-neutral-500">No tokens yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-xs">
          {tokens.map((t: APIToken) => (
            <li key={t.id} className="p-2 grid grid-cols-[1fr_auto] gap-2 items-center">
              <div>
                <div className="font-medium">{t.name}</div>
                <div className="text-neutral-500">
                  created {new Date(t.created_at).toLocaleDateString()}
                  {t.last_used_at && (
                    <> · last used {new Date(t.last_used_at).toLocaleString()}</>
                  )}
                </div>
              </div>
              <button
                className="text-red-400 hover:underline"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Revoke token "${t.name}"?`,
                    body: "Anything authenticating with it stops working immediately.",
                    confirmLabel: "Revoke",
                    tone: "danger",
                  });
                  if (ok) revoke.mutate(t.id);
                }}
              >
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
