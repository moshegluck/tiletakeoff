import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Layers } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { apiErr } from "@/lib/api";

function GoogleButton() {
  const onClick = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + "/dashboard";
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };
  return (
    <button type="button" onClick={onClick} data-testid="google-auth-btn"
      className="w-full flex items-center justify-center gap-2 border border-slate-300 hover:border-slate-900 font-bold py-2.5 rounded-sm transition-colors text-slate-800">
      <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="g" className="w-4 h-4" />
      Continue with Google
    </button>
  );
}

export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex w-1/2 blueprint-grid relative flex-col justify-between p-12 text-white">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center rounded-sm"><Layers className="w-5 h-5 text-white" /></div>
          <span className="font-black tracking-tight text-lg">TileTakeoff</span>
        </Link>
        <div>
          <h2 className="text-4xl font-black tracking-tighter leading-tight">Precision tile<br />takeoffs,<br /><span className="text-orange-500">faster bids.</span></h2>
          <p className="mt-4 text-slate-400 max-w-sm">Upload plans, measure surfaces, apply layouts and export professional estimates.</p>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Estimating Studio · v1.0</div>
      </div>
      <div className="flex-1 flex items-center justify-center p-8 bg-slate-50">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-black tracking-tight">{title}</h1>
          <p className="text-sm text-slate-500 mb-8">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@tiletakeoff.com");
  const [password, setPassword] = useState("Admin123!");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try { await login(email, password); navigate("/dashboard"); }
    catch (err) { setError(apiErr(err)); }
    finally { setLoading(false); }
  };

  const input = "w-full bg-white border border-slate-300 rounded-sm px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600 transition";

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your estimating workspace">
      <form onSubmit={submit} className="space-y-4">
        {error && <div data-testid="login-error" className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-sm">{error}</div>}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Email</label>
          <input data-testid="login-email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Password</label>
          <input data-testid="login-password" type="password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button data-testid="login-submit" disabled={loading} className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-sm transition-colors">
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </form>
      <div className="flex items-center gap-3 my-5 text-[10px] font-mono uppercase tracking-widest text-slate-400">
        <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
      </div>
      <GoogleButton />
      <p className="text-sm text-slate-500 mt-6 text-center">
        No account? <Link to="/register" className="text-orange-600 font-bold">Create one</Link>
      </p>
    </AuthLayout>
  );
}
