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
export type OrderStatus = "pending" | "open" | "in_progress" | "paused" | "completed";

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
  created_by?: string | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkOrderProposeIn = {
  plate: string;
  vin?: string;
  customer: string;
  vehicle: string;
  description: string;
};

/** Un operaio apre di sua iniziativa una commessa: resta "pending" finché il titolare non la approva. */
export async function proposeWorkOrder(body: WorkOrderProposeIn): Promise<WorkOrder> {
  return api<WorkOrder>("/work-orders/propose", { method: "POST", body });
}

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

export type SchedaTecnica = {
  marca?: string | null;
  modello?: string | null;
  anno?: string | null;
  motore?: string | null;
  km?: string | null;
  lavori_fatti: string[];
  lavori_da_fare: string[];
  ricambi_necessari: string[];
  note?: string | null;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  worker_id?: string | null;
  worker_full_name?: string | null;
};

export type Conversation = {
  work_order_id: string;
  scheda_tecnica: SchedaTecnica;
  turns: ConversationTurn[];
};

export type VoiceTurnResp = {
  assistant_text: string;
  scheda_tecnica: SchedaTecnica;
  turn: ConversationTurn;
};

export type PlateLookupResp = {
  found: boolean;
  scheda_tecnica: SchedaTecnica;
  turn: ConversationTurn | null;
};

/** Recupera i dati ufficiali del veicolo (marca, modello, motore, anno). Se plate è omessa, usa quella già salvata sulla commessa. */
export async function lookupPlate(orderId: string, plate?: string): Promise<PlateLookupResp> {
  return api<PlateLookupResp>(`/work-orders/${orderId}/lookup-plate`, {
    method: "POST",
    body: plate ? { plate } : {},
  });
}

export type WorkerOrderStats = {
  order_id: string;
  plate: string;
  vehicle: string;
  customer: string;
  events_count: number;
  minutes_worked: number;
  started_at?: string | null;
  last_event_at?: string | null;
};

export type WorkerDailyStats = {
  worker_id: string;
  username: string;
  full_name: string;
  events_count: number;
  minutes_worked: number;
  orders: WorkerOrderStats[];
};

export type DailyReport = {
  date: string;
  filter_worker_ids: string[];
  workers: WorkerDailyStats[];
  total_events: number;
  total_minutes: number;
  orders_touched: number;
  narrative: string;
  generated_at: string;
};

// ---- Archivio fotografico ----
export type OrderPhoto = {
  id: string;
  work_order_id: string;
  uploaded_by: string;
  uploaded_by_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

export async function listOrderPhotos(orderId: string): Promise<OrderPhoto[]> {
  return api<OrderPhoto[]>(`/work-orders/${orderId}/photos`);
}

export async function deleteOrderPhoto(photoId: string): Promise<void> {
  await api(`/photos/${photoId}`, { method: "DELETE" });
}

/** URL diretto del file foto (per <Image>); include il token in query. */
export async function orderPhotoUrl(photoId: string): Promise<string> {
  const t = await getToken();
  return `${BASE_URL}/api/photos/${photoId}/file?token=${encodeURIComponent(t || "")}`;
}

/** Carica una foto (data: URI da ImagePicker, o file: URI su nativo). */
export async function uploadOrderPhoto(orderId: string, uri: string): Promise<OrderPhoto> {
  const token = await getToken();
  const form = new FormData();
  if (uri.startsWith("data:") || uri.startsWith("blob:")) {
    const blob = await (await fetch(uri)).blob();
    const type = blob.type || "image/jpeg";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    form.append("file", new File([blob], `foto.${ext}`, { type }));
  } else {
    // @ts-expect-error RN form data typing
    form.append("file", { uri, name: "foto.jpg", type: "image/jpeg" });
  }
  const res = await fetch(`${BASE_URL}/api/work-orders/${orderId}/photos`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `Errore ${res.status}`);
  return data as OrderPhoto;
}

/** Upload multipart audio file to /api/audio/transcribe */
export async function transcribeAudio(uri: string, mimeType: string = "audio/m4a", filename: string = "note.m4a"): Promise<string> {
  const token = await (await import("@/src/utils/storage")).storage.secureGet<string>("officina_token", "");
  const form = new FormData();
  if (uri.startsWith("blob:") || uri.startsWith("data:")) {
    // Web: l'URI è un blob del browser — FormData vuole un Blob/File vero
    const blob = await (await fetch(uri)).blob();
    const type = blob.type || mimeType;
    const ext = type.includes("webm") ? "webm" : type.includes("mp4") ? "m4a" : type.includes("wav") ? "wav" : "webm";
    form.append("file", new File([blob], `note.${ext}`, { type }));
  } else {
    // Nativo (iOS/Android): FormData accetta { uri, name, type }
    // @ts-expect-error RN form data typing
    form.append("file", { uri, name: filename, type: mimeType });
  }
  const res = await fetch(`${BASE_URL}/api/audio/transcribe`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `Errore ${res.status}`);
  return (data && data.text) || "";
}
