import React, { useEffect, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, useLocation, useNavigate, Navigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Dashboard from "@/pages/Dashboard";
import Projects from "@/pages/Projects";
import ProjectDetail from "@/pages/ProjectDetail";
import TakeoffStudio from "@/pages/TakeoffStudio";
import Catalog from "@/pages/Catalog";
import Members from "@/pages/Members";
import MobileCompanion from "@/pages/MobileCompanion";
import AuditLog from "@/pages/AuditLog";
import Billing from "@/pages/Billing";
import AppShell from "@/components/AppShell";

function Loader() {
  return (
    <div className="h-screen w-full flex items-center justify-center bg-slate-950 text-orange-500 font-mono text-xs tracking-widest">
      LOADING TILETAKEOFF…
    </div>
  );
}

function Protected({ children, bare }) {
  const { user, loading } = useAuth();
  if (loading) return <Loader />;
  if (!user) return <Navigate to="/login" replace />;
  return bare ? children : <AppShell>{children}</AppShell>;
}

function AuthCallback() {
  const { googleSession } = useAuth();
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const hash = window.location.hash;
    const match = hash.match(/session_id=([^&]+)/);
    (async () => {
      if (match) {
        try { await googleSession(match[1]); } catch {}
      }
      window.history.replaceState(null, "", "/dashboard");
      navigate("/dashboard", { replace: true });
    })();
  }, [googleSession, navigate]);
  return <Loader />;
}

function AppRouter() {
  const location = useLocation();
  if (location.hash?.includes("session_id=")) return <AuthCallback />;
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/projects" element={<Protected><Projects /></Protected>} />
      <Route path="/projects/:id" element={<Protected><ProjectDetail /></Protected>} />
      <Route path="/takeoff/:id" element={<Protected bare><TakeoffStudio /></Protected>} />
      <Route path="/catalog" element={<Protected><Catalog /></Protected>} />
      <Route path="/team" element={<Protected><Members /></Protected>} />
      <Route path="/audit" element={<Protected><AuditLog /></Protected>} />
      <Route path="/billing" element={<Protected><Billing /></Protected>} />
      <Route path="/m" element={<Protected bare><MobileCompanion /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRouter />
        <Toaster position="top-right" />
      </BrowserRouter>
    </AuthProvider>
  );
}
