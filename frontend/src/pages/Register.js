import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { apiErr } from "@/lib/api";
import { AuthLayout } from "@/pages/Login";

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", company_name: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const input = "w-full bg-white border border-slate-300 rounded-sm px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600 transition";

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try { await register(form); navigate("/dashboard"); }
    catch (err) { setError(apiErr(err)); }
    finally { setLoading(false); }
  };

  return (
    <AuthLayout title="Create your workspace" subtitle="Start your first tile takeoff in minutes">
      <form onSubmit={submit} className="space-y-4">
        {error && <div data-testid="register-error" className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-sm">{error}</div>}
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Full Name</label>
          <input data-testid="register-name" className={input} value={form.name} onChange={set("name")} required />
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Company / Workspace</label>
          <input data-testid="register-company" className={input} value={form.company_name} onChange={set("company_name")} placeholder="Acme Tile Co." />
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Email</label>
          <input data-testid="register-email" type="email" className={input} value={form.email} onChange={set("email")} required />
        </div>
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Password</label>
          <input data-testid="register-password" type="password" className={input} value={form.password} onChange={set("password")} required minLength={6} />
        </div>
        <button data-testid="register-submit" disabled={loading} className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-sm transition-colors">
          {loading ? "Creating…" : "Create Workspace"}
        </button>
      </form>
      <p className="text-sm text-slate-500 mt-6 text-center">
        Already have an account? <Link to="/login" className="text-orange-600 font-bold">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
