import React, { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { api, apiErr } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { UserPlus, Shield, Users } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";

const fetcher = (url) => api.get(url).then((r) => r.data);
const input = "w-full bg-slate-50 border border-slate-300 rounded-sm px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600";
const ROLE_COLORS = { admin: "bg-orange-100 text-orange-700", estimator: "bg-blue-100 text-blue-700", viewer: "bg-slate-100 text-slate-600" };

export default function Members() {
  const { user } = useAuth();
  const { data, mutate } = useSWR("/workspace", fetcher);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "estimator" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const invite = async () => {
    if (!form.name || !form.email || !form.password) return toast.error("All fields required");
    try { await api.post("/workspace/members", form); toast.success("Member added"); setOpen(false); setForm({ name: "", email: "", password: "", role: "estimator" }); mutate(); }
    catch (e) { toast.error(apiErr(e)); }
  };

  const isAdmin = user?.role === "admin";

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-end justify-between mb-8">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">{data?.workspace?.name}</div>
          <h1 className="text-3xl font-black tracking-tight">Team & Roles</h1>
        </div>
        {isAdmin && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <button data-testid="invite-member-btn" className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2.5 rounded-sm transition-colors"><UserPlus className="w-4 h-4" /> Add Member</button>
            </DialogTrigger>
            <DialogContent className="rounded-sm">
              <DialogHeader><DialogTitle className="font-black tracking-tight">Add Team Member</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <input data-testid="member-name-input" className={input} placeholder="Full name" value={form.name} onChange={set("name")} />
                <input data-testid="member-email-input" type="email" className={input} placeholder="Email" value={form.email} onChange={set("email")} />
                <input data-testid="member-password-input" type="password" className={input} placeholder="Temp password" value={form.password} onChange={set("password")} />
                <select data-testid="member-role-select" className={input} value={form.role} onChange={set("role")}>
                  <option value="admin">Admin — full control</option>
                  <option value="estimator">Estimator — create & edit takeoffs</option>
                  <option value="viewer">Viewer — read only</option>
                </select>
              </div>
              <DialogFooter><button data-testid="save-member-btn" onClick={invite} className="bg-orange-600 hover:bg-orange-700 text-white font-bold px-4 py-2 rounded-sm transition-colors">Add Member</button></DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="border border-slate-200 bg-white">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2"><Users className="w-4 h-4 text-orange-600" /><h2 className="text-sm font-bold uppercase tracking-wider">{data?.members?.length || 0} Members</h2></div>
        <div className="divide-y divide-slate-100">
          {(data?.members || []).map((m) => (
            <div key={m.id} className="flex items-center justify-between px-5 py-3" data-testid={`member-row-${m.id}`}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-sm bg-slate-900 text-orange-500 flex items-center justify-center font-bold">{m.name[0]?.toUpperCase()}</div>
                <div>
                  <div className="text-sm font-bold">{m.name} {m.id === user.id && <span className="text-slate-400 font-normal">(you)</span>}</div>
                  <div className="text-[11px] font-mono text-slate-500">{m.email}</div>
                </div>
              </div>
              <span className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-sm inline-flex items-center gap-1 ${ROLE_COLORS[m.role]}`}><Shield className="w-3 h-3" /> {m.role}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
