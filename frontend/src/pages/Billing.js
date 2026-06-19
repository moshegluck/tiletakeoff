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

  const current = data?.plan || "free";
  const plans = data?.plans || {};
  return (
    <div className="p-8 max-w-4xl" data-testid="billing-page">
      <div className="mb-8">
        <div className="text-[11px] font-mono uppercase tracking-widest text-orange-600 mb-1">Subscription</div>
        <h1 className="text-3xl font-black tracking-tight flex items-center gap-2"><CreditCard className="w-7 h-7" /> Billing &amp; Plans</h1>
        <p className="text-sm text-slate-500 mt-1">You're on the <b className="text-slate-900 capitalize" data-testid="current-plan">{current}</b> plan. {checking && <span className="text-orange-600 font-bold">Confirming payment…</span>}</p>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        {ORDER.map((pid) => {
          const p = plans[pid]; if (!p) return null;
          const isCurrent = pid === current;
          const isUpgrade = ORDER.indexOf(pid) > ORDER.indexOf(current);
          return (
            <div key={pid} data-testid={`plan-${pid}`} className={`rounded-lg border p-5 flex flex-col ${pid === "pro" ? "border-orange-500 shadow-lg" : "border-slate-200"} bg-white`}>
              {pid === "pro" && <div className="text-[10px] font-mono uppercase tracking-widest text-orange-600 mb-1 flex items-center gap-1"><Sparkles className="w-3 h-3" /> Most popular</div>}
              <div className="font-black text-lg">{p.name}</div>
              <div className="text-3xl font-black mt-1">${p.price}<span className="text-sm font-mono text-slate-400">/mo</span></div>
              <p className="text-xs text-slate-500 mt-2 flex-1">{p.blurb}</p>
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
