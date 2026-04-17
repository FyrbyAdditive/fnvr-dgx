import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function Settings() {
  const { data } = useQuery({ queryKey: ["info"], queryFn: api.systemInfo });
  return (
    <div className="p-4 space-y-2">
      <h2 className="text-lg font-semibold">System</h2>
      <pre className="text-xs bg-neutral-900 rounded p-3">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
