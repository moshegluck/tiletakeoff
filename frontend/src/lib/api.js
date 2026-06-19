import axios from "axios";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API, withCredentials: false });

export function setToken(token) {
  if (token) localStorage.setItem("tt_token", token);
  else localStorage.removeItem("tt_token");
}
export function getToken() {
  return localStorage.getItem("tt_token");
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Plan-gate (402) → prompt upgrade
api.interceptors.response.use(
  (r) => r,
  (e) => {
    if (e?.response?.status === 402) {
      const msg = e.response.data?.detail || "Upgrade required to use this feature.";
      toast.error(msg, { action: { label: "View plans", onClick: () => { window.location.href = "/billing"; } } });
    }
    return Promise.reject(e);
  }
);

export function fileUrl(drawingId) {
  return `${API}/drawings/${drawingId}/file?auth=${encodeURIComponent(getToken() || "")}`;
}
export function exportUrl(takeoffId, fmt) {
  return `${API}/takeoffs/${takeoffId}/export/${fmt}?auth=${encodeURIComponent(getToken() || "")}`;
}

export function apiErr(e) {
  const d = e?.response?.data?.detail;
  if (d == null) return e?.message || "Something went wrong";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x?.msg || JSON.stringify(x)).join(" ");
  return String(d);
}
