import React, { useEffect, useState, useCallback } from "react";
import useSWR from "swr";
import { api, apiErr } from "@/lib/api";
import { toast } from "sonner";
import { Check, Sparkles, CreditCard } from "lucide-react";

const fetcher = (url) => api.get(url).then((r) => r.data);
const ORDER = ["free", "pro", "team"];

export default function Billing() {
  const { data, mutate } = useSWR("/billing/me", fetcher);
  const [busy, setBusy] = useState(null);
  const [checking, setChecking] = useState(false);

  const poll = useCallback(async (sessionId, attempts = 0) => {
    if (attempts >= 6) { setChecking(false); toast.error("Payment status timed out — refresh to check."); return; }
    try {
      const { data: s } = await api.get(`/billing/status/${sessionId}`);
      if (s.payment_status === "paid") { setChecking(false); toast.success("Payment successful — plan upgraded!"); mutate(); return; }
      if (s.status === "expired") { setChecking(false); toast.error("Payment session expired."); return; }
    } catch { /* keep polling */ }
    setTimeout(() => poll(sessionId, attempts + 1), 2000);
  }, [mutate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("session_id");
    if (sid) {
      setChecking(true);
      poll(sid);
      window.history.replaceState({}, "", "/billing");
    }
  }, [poll]);

  const upgrade = async (planId) => {
    setBusy(planId);
    try {
      const { data: r } = await api.post("/billing/checkout", { plan_id: planId, origin_url: window.location.origin });
      window.location.href = r.url;
    } catch (e) { toast.error(apiErr(e)); setBusy(null); }
  };
  const cancelSub = async () => {
    if (!window.confirm("Cancel your subscription? You'll keep access until the end of the current period, then drop to Free.")) return;
    try { await api.post("/billing/cancel"); toast.success("Subscription will cancel at period end"); mutate(); }
    catch (e) { toast.error(apiErr(e)); }
  };
  const reactivateSub = async () => {
    try { await api.post("/billing/reactivate"); toast.success("Subscription reactivated"); mutate(); }
    catch (e) { toast.error(apiErr(e)); }
  };
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

  const current = data?.plan || "free";
  const plans = data?.plans || {};
  const limits = data?.limits || {};
  const usage = data?.usage || {};
  const FEATURES = [
    ["max_projects", (v) => `${v === null ? "Unlimited" : v} project${v === 1 ? "" : "s"}`],
    ["ai", () => "AI-assisted takeoff"],
    ["exports", () => "PDF / Excel / CSV exports"],
    ["email", () => "Email reports to clients"],
    ["max_members", (v) => `${v === null ? "Unlimited" : v} team seat${v === 1 ? "" : "s"}`],
    ["audit", () => "Activity / audit log"],
  ];
  return (
    <div className="p-8 max-w-4xl" data-testid="billing-page">
      <div className="mb-8">
        <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">Subscription</div>
        <h1 className="text-3xl font-black tracking-tight flex items-center gap-2"><CreditCard className="w-7 h-7" /> Billing &amp; Plans</h1>
        <p className="text-sm text-slate-500 mt-1">You're on the <b className="text-slate-900 capitalize" data-testid="current-plan">{current}</b> plan
          {usage.projects != null && <> · {usage.projects} project{usage.projects === 1 ? "" : "s"}, {usage.members} seat{usage.members === 1 ? "" : "s"} in use</>}.
          {checking && <span className="text-orange-600 font-bold"> Confirming payment…</span>}</p>
      </div>
      {current !== "free" && (
        <div className="mb-6 bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3" data-testid="manage-subscription">
          <div className="text-sm">
            {data?.cancel_at_period_end
              ? <span className="text-amber-700 font-bold">Cancels on {fmtDate(data?.current_period_end)}</span>
              : <span className="text-slate-700"><b className="text-green-700">Active</b> · renews {fmtDate(data?.current_period_end)}</span>}
          </div>
          {data?.cancel_at_period_end
            ? <button data-testid="reactivate-btn" onClick={reactivateSub} className="text-sm font-bold bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-sm">Reactivate</button>
            : <button data-testid="cancel-sub-btn" onClick={cancelSub} className="text-sm font-bold border border-slate-300 hover:border-red-500 hover:text-red-600 px-4 py-2 rounded-sm">Cancel subscription</button>}
        </div>
      )}
      <div className="grid sm:grid-cols-3 gap-4">
        {ORDER.map((pid) => {
          const p = plans[pid]; if (!p) return null;
          const isCurrent = pid === current;
          const isUpgrade = ORDER.indexOf(pid) > ORDER.indexOf(current);
          const lim = limits[pid] || {};
          return (
            <div key={pid} data-testid={`plan-${pid}`} className={`rounded-lg border p-5 flex flex-col ${pid === "pro" ? "border-orange-500 shadow-lg" : "border-slate-200"} bg-white`}>
              {pid === "pro" && <div className="text-[10px] font-mono uppercase tracking-widest text-orange-600 mb-1 flex items-center gap-1"><Sparkles className="w-3 h-3" /> Most popular</div>}
              <div className="font-black text-lg">{p.name}</div>
              <div className="text-3xl font-black mt-1">${p.price}<span className="text-sm font-mono text-slate-400">/mo</span></div>
              <ul className="mt-3 space-y-1.5 flex-1">
                {FEATURES.map(([k, fmt]) => {
                  const v = lim[k];
                  const on = k === "max_projects" || k === "max_members" ? true : !!v;
                  return (
                    <li key={k} className={`text-xs flex items-center gap-1.5 ${on ? "text-slate-700" : "text-slate-300 line-through"}`}>
                      <Check className={`w-3.5 h-3.5 shrink-0 ${on ? "text-green-600" : "text-slate-300"}`} />{fmt(v)}
                    </li>
                  );
                })}
              </ul>
              {isCurrent ? (
                <div className="mt-4 text-center text-sm font-bold text-green-700 bg-green-50 rounded-sm py-2 flex items-center justify-center gap-1"><Check className="w-4 h-4" /> Current plan</div>
              ) : pid === "free" ? (
                <div className="mt-4 text-center text-xs text-slate-400 py-2">Contact support to downgrade</div>
              ) : (
                <button data-testid={`upgrade-${pid}`} disabled={busy === pid} onClick={() => upgrade(pid)}
                  className="mt-4 bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2 rounded-sm text-sm">
                  {busy === pid ? "Redirecting…" : isUpgrade ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-400 mt-4 font-mono">Payments are processed securely by Stripe (test mode). No card is charged in test mode.</p>
    </div>
  );
}
