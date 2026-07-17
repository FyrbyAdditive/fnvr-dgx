import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { TokensPanel } from "./TokensPanel";

export function UsersTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: api.listUsers,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateUser>[1] }) =>
      api.updateUser(id, body),
    onSuccess: (_, vars) => {
      invalidate();
      if (vars.body.role) toast.success("Role updated");
      else if (vars.body.disabled !== undefined) {
        toast.success(vars.body.disabled ? "User disabled" : "User enabled");
      }
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "update failed")),
  });
  const del = useMutation({
    mutationFn: api.deleteUser,
    onSuccess: () => {
      invalidate();
      toast.success("User deleted");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "delete failed")),
  });

  const [showTokensFor, setShowTokensFor] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<{ id: string; username: string } | null>(null);

  return (
    <Card
      title="Users"
      description="Admin can edit everything. Viewer can read everything but cannot change settings, cameras, zones, or rules. API-only users cannot log into the web UI; they authenticate with personal access tokens in the Authorization header."
    >
      <NewUserForm onCreated={invalidate} />

      {users.length === 0 ? (
        <p className="text-neutral-500 text-sm">No users yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm">
          {users.map((u) => (
            <li key={u.id} className="p-2">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                <div>
                  <div className="font-medium">
                    {u.username}{" "}
                    <span className="text-neutral-500 font-normal">
                      · {prettyRole(u.role)}
                      {u.api_only && <span className="text-emerald-400"> · api-only</span>}
                      {u.disabled && <span className="text-amber-500"> · disabled</span>}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    created {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <select
                    className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
                    value={normaliseRole(u.role)}
                    disabled={update.isPending}
                    onChange={async (e) => {
                      const role = e.target.value as "admin" | "viewer";
                      // Controlled by the server value — if the confirm is
                      // declined we simply don't mutate and the select
                      // snaps back on re-render.
                      const ok = await confirm({
                        title: `Change role of "${u.username}" to ${role}?`,
                        body:
                          role === "admin"
                            ? "Admins have full control over settings, cameras, users and rules."
                            : "Viewers can watch and browse but not change anything.",
                        confirmLabel: "Change role",
                      });
                      if (ok) update.mutate({ id: u.id, body: { role } });
                      else e.target.value = normaliseRole(u.role);
                    }}
                  >
                    <option value="admin">admin</option>
                    <option value="viewer">viewer</option>
                  </select>
                  <button
                    className={u.disabled ? "text-emerald-400 hover:underline" : "text-amber-400 hover:underline"}
                    onClick={() =>
                      update.mutate({ id: u.id, body: { disabled: !u.disabled } })
                    }
                  >
                    {u.disabled ? "enable" : "disable"}
                  </button>
                  {u.api_only ? (
                    <button
                      className="text-blue-400 hover:underline"
                      onClick={() =>
                        setShowTokensFor(showTokensFor === u.id ? null : u.id)
                      }
                    >
                      {showTokensFor === u.id ? "hide tokens" : "tokens"}
                    </button>
                  ) : (
                    <button
                      className="text-blue-400 hover:underline"
                      onClick={() => setResetFor({ id: u.id, username: u.username })}
                      title="Set a new password for this user"
                    >
                      reset pw
                    </button>
                  )}
                </div>
                <button
                  className="text-xs text-red-400 hover:underline"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete user "${u.username}"?`,
                      body: "This cannot be undone. Any API tokens are revoked.",
                      confirmLabel: "Delete",
                      tone: "danger",
                    });
                    if (ok) del.mutate(u.id);
                  }}
                >
                  delete
                </button>
              </div>
              {showTokensFor === u.id && u.api_only && <TokensPanel userID={u.id} />}
            </li>
          ))}
        </ul>
      )}

      <PasswordResetDialog target={resetFor} onClose={() => setResetFor(null)} />
    </Card>
  );
}

function prettyRole(r: string): string {
  // Legacy rows may have "superadmin"/"operator"/"guest"; show them as
  // they map to the handler-side gate.
  if (r === "superadmin" || r === "admin") return "admin";
  return "viewer";
}
function normaliseRole(r: string): "admin" | "viewer" {
  return prettyRole(r) as "admin" | "viewer";
}

function PasswordResetDialog({
  target,
  onClose,
}: {
  target: { id: string; username: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const update = useMutation({
    mutationFn: () => api.updateUser(target!.id, { password }),
    onSuccess: () => {
      toast.success(`Password updated for ${target?.username}`);
      setPassword("");
      onClose();
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "password update failed")),
  });
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      ariaLabel={`Reset password for ${target?.username ?? "user"}`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) update.mutate();
        }}
      >
        <h3 className="text-base font-semibold">Reset password — {target?.username}</h3>
        <input
          type="password"
          autoFocus
          className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="text-xs text-neutral-500">
          The user's sessions are invalidated — they will need to log in again.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="text-sm px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            disabled={!password || update.isPending}
          >
            {update.isPending ? "Saving…" : "Set password"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [apiOnly, setApiOnly] = useState(false);

  const create = useMutation({
    mutationFn: api.createUser,
    onSuccess: (u) => {
      onCreated();
      toast.success(`User "${u.username}" created`);
      setUsername("");
      setPassword("");
      setRole("viewer");
      setApiOnly(false);
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "create failed")),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({
      username: username.trim(),
      password: apiOnly ? undefined : password,
      role,
      api_only: apiOnly,
    });
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-[1fr_1fr_8rem_auto_auto] gap-2 items-center">
      <input
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />
      <input
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm disabled:opacity-50"
        placeholder={apiOnly ? "(no password — api-only)" : "Password"}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={apiOnly}
        required={!apiOnly}
      />
      <select
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        value={role}
        onChange={(e) => setRole(e.target.value as "admin" | "viewer")}
      >
        <option value="viewer">viewer</option>
        <option value="admin">admin</option>
      </select>
      <label className="inline-flex items-center gap-1 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={apiOnly}
          onChange={(e) => setApiOnly(e.target.checked)}
        />
        api-only
      </label>
      <button
        type="submit"
        className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
        disabled={create.isPending}
      >
        {create.isPending ? "adding…" : "add user"}
      </button>
    </form>
  );
}
