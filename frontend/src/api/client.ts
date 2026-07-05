import { storage } from "@/src/utils/storage";

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL;
const TOKEN_KEY = "officina_token";

async function getToken(): Promise<string | null> {
  return (await storage.secureGet<string>(TOKEN_KEY, "")) || null;
}

export async function setToken(token: string): Promise<void> {
  await storage.secureSet(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await storage.secureRemove(TOKEN_KEY);
}

export type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: any;
  auth?: boolean;
};

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    const t = await getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.detail) || `Errore ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export type Role = "admin" | "worker";
export type EventType = "START" | "PAUSE" | "RESUME" | "COMPLETE";
export type OrderStatus = "open" | "in_progress" | "paused" | "completed";

export type User = {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  created_at: string;
};

export type WorkOrder = {
  id: string;
  plate: string;
  vin?: string | null;
  customer: string;
  vehicle: string;
  description: string;
  assigned_worker_ids: string[];
  status: OrderStatus;
  created_at: string;
  updated_at: string;
};

export type WorkEvent = {
  id: string;
  work_order_id: string;
  worker_id: string;
  worker_username: string;
  worker_full_name: string;
  type: EventType;
  reason?: string | null;
  photos_base64: string[];
  timestamp: string;
  ai_interpretation?: string | null;
};

export type LiveStatus = {
  worker_id: string;
  username: string;
  full_name: string;
  current_status: "working" | "paused" | "idle";
  current_work_order_id?: string | null;
  current_work_order_label?: string | null;
  since?: string | null;
  minutes_since?: number | null;
  last_reason?: string | null;
};
