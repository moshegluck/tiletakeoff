import React from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { ScrollText } from "lucide-react";

const fetcher = (url) => api.get(url).then((r) => r.data);

export default function AuditLog() {
  const { data, error } = useSWR("/audit", fetcher);
  const logs = data?.logs || [];
  return (
    <div className="p-8 max-w-4xl" data-testid="audit-page">
      <div className="mb-8">
        <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">Compliance</div>
        <h1 className="text-3xl font-black tracking-tight flex items-center gap-2"><ScrollText className="w-7 h-7" /> Activity Log</h1>
        <p className="text-sm text-slate-500 mt-1">Audit trail of key actions across your workspace.</p>
      </div>
      {error && <div className="text-sm text-red-600">{error?.response?.status === 403 ? "Admins only." : "Could not load activity."}</div>}
      <div className="bg-white border border-slate-200 rounded-sm divide-y divide-slate-100" data-testid="audit-list">
        {logs.length === 0 && !error && <div className="p-8 text-center text-slate-400 text-sm">No activity recorded yet.</div>}
        {logs.map((l) => (
          <div key={l.id} className="px-4 py-3 flex items-center gap-3" data-testid={`audit-${l.id}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm"><b>{l.user_name}</b> <span className="text-slate-500">{l.action}</span> {l.detail && <span className="font-mono text-slate-700">— {l.detail}</span>}</div>
              <div className="text-[11px] font-mono text-slate-400">{l.entity} · {new Date(l.created_at).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
