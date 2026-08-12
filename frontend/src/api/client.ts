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
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
    const detail = data && data.detail;
    // Il backend a volte spiega il rifiuto con un oggetto (es. il doppione di targa):
    // il messaggio resta leggibile, ma i dettagli viaggiano attaccati all'errore.
    const msg = typeof detail === "string" ? detail : detail?.messaggio || `Errore ${res.status}`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return data as T;
}

export type Role = "admin" | "worker";
/** KM non è un passaggio di lavoro: è la correzione di un chilometraggio sbagliato. */
export type EventType = "START" | "PAUSE" | "RESUME" | "COMPLETE" | "KM";
export type OrderStatus = "pending" | "open" | "in_progress" | "paused" | "completed";

export type User = {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  created_at: string;
  /** false = questo utente non timbra il cartellino e non lo vede */
  cartellino_attivo?: boolean;
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
  scheda_tecnica?: SchedaTecnica;
  created_by?: string | null;
  created_by_name?: string | null;
  minutes_calculated?: number | null;
  minutes_effective?: number | null;
  minutes_effective_reason?: string | null;
  /** null = ancora da approvare (ma il meccanico puo gia lavorarci) */
  approvata_il?: string | null;
  approvata_da_nome?: string | null;
  /** null su una commessa completata = fattura ancora da preparare */
  fatturata_il?: string | null;
  fatturata_da_nome?: string | null;
  created_at: string;
  updated_at: string;
};

/** Le commesse finite di cui il titolare non ha ancora preparato la fattura. */
export function daFatturare(orders: WorkOrder[]): WorkOrder[] {
  return orders
    .filter((o) => o.status === "completed" && !o.fatturata_il)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

export type WorkOrderProposeIn = {
  plate: string;
  vin?: string;
  customer?: string;  // se assente, arriva da STAR
  vehicle?: string;   // idem
  description: string;
};

/** Un operaio apre di sua iniziativa una commessa: puo lavorarci subito, il titolare la approva dopo. */
export async function proposeWorkOrder(body: WorkOrderProposeIn): Promise<WorkOrder> {
  return api<WorkOrder>("/work-orders/propose", { method: "POST", body });
}

/** Il backend rifiuta la seconda commessa sulla stessa targa e dice qual e' quella buona. */
export type CommessaGiaAperta = {
  codice: "commessa_gia_aperta";
  messaggio: string;
  commessa_id: string;
  plate: string;
  vehicle: string;
  descrizione: string;
  aperta_da: string;
  aperta_il: string;
  stato: OrderStatus;
};

export function doppioneDiTarga(e: any): CommessaGiaAperta | null {
  return e?.detail?.codice === "commessa_gia_aperta" ? (e.detail as CommessaGiaAperta) : null;
}

/** Il meccanico si mette sulla commessa che esiste gia' (quelle da STAR non hanno nessuno). */
export async function prendiCommessa(orderId: string): Promise<WorkOrder> {
  return api<WorkOrder>(`/work-orders/${orderId}/prendi`, { method: "POST" });
}

/** Genera HTML stampabile per le commesse selezionate. */
export async function stampaCommesse(orderIds: string[]): Promise<string> {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}/api/work-orders/stampa-html`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ order_ids: orderIds }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Errore ${res.status}`);
  return text;
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
  km?: string | null;
  /** valorizzato su INIZIA quando il meccanico rinvia i km alla chiusura */
  km_deferred_reason?: string | null;
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
  ricambi_sostituiti: string[];
  note?: string | null;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  worker_id?: string | null;
  worker_full_name?: string | null;
  edited_at?: string | null;
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

export type PlateLookupQueued = {
  queued: boolean;
  request_id: string | null;
  message: string;
};

/** Mette in coda la richiesta dati veicolo: Omnius la ritira da STAR e la risposta arriva nella scheda (10-60s). */
export async function lookupPlate(orderId: string, plate?: string): Promise<PlateLookupQueued> {
  return api<PlateLookupQueued>(`/work-orders/${orderId}/lookup-plate`, {
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

// ---- Messaggi commessa (admin <-> operai) ----
export type OrderMessage = {
  id: string;
  work_order_id: string;
  sender_id: string;
  sender_name: string;
  sender_role: Role;
  text: string;
  created_at: string;
  edited_at?: string | null;
};

export async function listOrderMessages(orderId: string): Promise<OrderMessage[]> {
  return api<OrderMessage[]>(`/work-orders/${orderId}/messages`);
}

export async function sendOrderMessage(orderId: string, text: string): Promise<OrderMessage> {
  return api<OrderMessage>(`/work-orders/${orderId}/messages`, { method: "POST", body: { text } });
}

/** Modifica un proprio messaggio (resta marcato "modificato"). */
export async function editOrderMessage(messageId: string, text: string): Promise<OrderMessage> {
  return api<OrderMessage>(`/messages/${messageId}`, { method: "PUT", body: { text } });
}

/** Cancella un proprio messaggio. */
export async function deleteOrderMessage(messageId: string): Promise<void> {
  await api(`/messages/${messageId}`, { method: "DELETE" });
}

/** Spunta/togli spunta a un lavoro della checklist (sposta tra da_fare e fatti). */
export async function toggleLavoro(orderId: string, item: string, done: boolean): Promise<SchedaTecnica> {
  return api<SchedaTecnica>(`/work-orders/${orderId}/scheda/toggle-lavoro`, {
    method: "POST",
    body: { item, done },
  });
}

/** Spunta un ricambio come VERAMENTE sostituito (sposta tra necessari e sostituiti). */
export async function toggleRicambio(orderId: string, item: string, done: boolean): Promise<SchedaTecnica> {
  return api<SchedaTecnica>(`/work-orders/${orderId}/scheda/toggle-ricambio`, {
    method: "POST",
    body: { item, done },
  });
}

/** Corregge le ore effettive (per la fattura). minutes=null azzera la correzione. */
/** Ore proposte alla chiusura: lette da ciò che il meccanico ha scritto, o dai timbri se non le ha dette. */
export type OreProposte = {
  minuti_proposti: number;
  minuti_timbri: number;
  /** "note" = lette dal meccanico · "timbri" = non le ha scritte · "errore" = AI non disponibile */
  fonte: "note" | "timbri" | "errore";
  citazione?: string | null;
  dettaglio?: string | null;
};

export async function oreProposte(orderId: string): Promise<OreProposte> {
  return api<OreProposte>(`/work-orders/${orderId}/ore-proposte`);
}

export async function setEffectiveHours(orderId: string, minutes: number | null, reason: string | null): Promise<WorkOrder> {
  return api<WorkOrder>(`/work-orders/${orderId}/effective-hours`, {
    method: "POST",
    body: { minutes, reason },
  });
}

/** Modifica un proprio messaggio nel dialogo AI (l'AI non ri-risponde: corregge il registro). */
export async function editDialogTurn(orderId: string, turnIndex: number, text: string): Promise<Conversation> {
  return api<Conversation>(`/work-orders/${orderId}/conversation/turns/${turnIndex}`, { method: "PUT", body: { text } });
}

/** Cancella un proprio messaggio del dialogo AI, anche un vocale trascritto. */
export async function deleteDialogTurn(orderId: string, turnIndex: number): Promise<Conversation> {
  return api<Conversation>(`/work-orders/${orderId}/conversation/turns/${turnIndex}`, { method: "DELETE" });
}

export type UnreadMessages = { total: number; by_order: Record<string, number> };

export async function unreadMessages(): Promise<UnreadMessages> {
  return api<UnreadMessages>("/messages/unread");
}

export async function getVapidPublicKey(): Promise<string> {
  const r = await api<{ key: string }>("/push/vapid-public");
  return r.key;
}

export async function savePushSubscription(sub: any): Promise<void> {
  await api("/push/subscribe", { method: "POST", body: sub });
}

// ---- Archivio Tecnico (documentazione ufficiale) ----
export type KnowledgeDoc = {
  doc_id: string;
  title: string;
  chunks: number;
  created_by_name?: string | null;
  created_at: string;
};

export async function listKnowledge(): Promise<KnowledgeDoc[]> {
  return api<KnowledgeDoc[]>("/knowledge");
}

export async function addKnowledgeText(title: string, content: string): Promise<KnowledgeDoc> {
  return api<KnowledgeDoc>("/knowledge", { method: "POST", body: { title, content } });
}

export async function deleteKnowledgeDoc(docId: string): Promise<void> {
  await api(`/knowledge/${docId}`, { method: "DELETE" });
}

/** Carica un PDF nell'Archivio Tecnico (solo web/admin). */
export async function uploadKnowledgePdf(fileUri: string, filename: string): Promise<KnowledgeDoc> {
  const token = await getToken();
  const form = new FormData();
  if (fileUri.startsWith("data:") || fileUri.startsWith("blob:")) {
    const blob = await (await fetch(fileUri)).blob();
    form.append("file", new File([blob], filename, { type: "application/pdf" }));
  } else {
    // @ts-expect-error RN form data typing
    form.append("file", { uri: fileUri, name: filename, type: "application/pdf" });
  }
  const res = await fetch(`${BASE_URL}/api/knowledge/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `Errore ${res.status}`);
  return data as KnowledgeDoc;
}

// ---- Archivio fotografico ----
export type OrderPhoto = {
  id: string;
  work_order_id: string;
  uploaded_by: string;
  uploaded_by_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  caption?: string | null;
  /** "libretto" = la foto obbligatoria scattata all'inizio del lavoro */
  kind?: string | null;
  /** campi del libretto estratti dall'OCR: alimentazione, motore, euro, gomme… */
  dati?: Record<string, string | null> | null;
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

/** Carica una foto o un video (data:/blob: URI da ImagePicker, o file: URI su nativo). */
/** kind="ricambio": l'AI legge i codici articolo dalla scatola e finiscono nel riepilogo del titolare. */
export async function uploadOrderPhoto(orderId: string, uri: string, mimeHint?: string, kind?: string): Promise<OrderPhoto> {
  const token = await getToken();
  const form = new FormData();
  const extFor = (t: string) =>
    t.includes("png") ? "png" : t.includes("webp") ? "webp" : t.includes("mp4") ? "mp4"
    : t.includes("webm") ? "webm" : t.includes("quicktime") ? "mov" : "jpg";
  if (uri.startsWith("data:") || uri.startsWith("blob:")) {
    const blob = await (await fetch(uri)).blob();
    const type = blob.type || mimeHint || "image/jpeg";
    form.append("file", new File([blob], `media.${extFor(type)}`, { type }));
  } else {
    const type = mimeHint || "image/jpeg";
    // @ts-expect-error RN form data typing
    form.append("file", { uri, name: `media.${extFor(type)}`, type });
  }
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const res = await fetch(`${BASE_URL}/api/work-orders/${orderId}/photos${qs}`, {
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

// ---------------- Cartellino presenze ----------------

export type Timbratura = {
  id: string;
  worker_id: string;
  worker_name: string;
  tipo: "ENTRATA" | "USCITA";
  timestamp: string;
  giorno: string;
  lat?: number | null;
  lon?: number | null;
  accuracy_m?: number | null;
  distanza_m?: number | null;
  fuori_zona: boolean;
  posizione_assente: boolean;
  corretta_da_nome?: string | null;
  motivo_correzione?: string | null;
};

export type Giornata = {
  giorno: string;
  minuti_presenza: number;
  minuti_target: number;
  /** quello che matura davvero, tolleranza già applicata */
  differenza: number;
  /** quanto ha fatto in più prima della tolleranza */
  differenza_lorda?: number;
  /** minuti assorbiti dallo sfrido fisiologico */
  tolleranza_applicata?: number;
  incompleta: boolean;
  dentro_adesso: boolean;
  timbrature: Timbratura[];
};

export type Cartellino = {
  worker_id: string;
  worker_name: string;
  giornate: Giornata[];
  saldo_minuti: number;
  giorni_incompleti: number;
};

export type PosizioneOfficina = {
  lat?: number | null;
  lon?: number | null;
  raggio_m: number;
  impostata_da_nome?: string | null;
  impostata_il?: string | null;
  configurata: boolean;
};

/** Un tocco solo: se sei fuori entri, se sei dentro esci. */
export async function timbra(pos: { lat: number; lon: number; accuracy_m?: number } | null): Promise<Timbratura> {
  return api<Timbratura>("/timbrature", { method: "POST", body: pos ?? {} });
}

export async function mioCartellino(giorni = 60): Promise<Cartellino> {
  return api<Cartellino>(`/timbrature/mio-cartellino?giorni=${giorni}`);
}

export async function cartellini(giorni = 30): Promise<Cartellino[]> {
  return api<Cartellino[]>(`/timbrature/cartellini?giorni=${giorni}`);
}

export async function correggiTimbratura(
  id: string, body: { timestamp?: string; tipo?: "ENTRATA" | "USCITA"; motivo: string },
): Promise<Timbratura> {
  return api<Timbratura>(`/timbrature/${id}`, { method: "PATCH", body });
}

export async function eliminaTimbratura(id: string): Promise<void> {
  await api(`/timbrature/${id}`, { method: "DELETE" });
}

export async function leggiPosizioneOfficina(): Promise<PosizioneOfficina> {
  return api<PosizioneOfficina>("/officina/posizione");
}

export async function impostaPosizioneOfficina(lat: number, lon: number, raggio_m = 500): Promise<PosizioneOfficina> {
  return api<PosizioneOfficina>("/officina/posizione", { method: "POST", body: { lat, lon, raggio_m } });
}

/** "8h 30m" · "+15 min" · "−1h 05m" */
export function fmtDurata(minuti: number): string {
  const seg = minuti < 0 ? "−" : "";
  const m = Math.abs(minuti);
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? `${seg}${h}h ${String(mm).padStart(2, "0")}m` : `${seg}${mm}m`;
}

/** Aggiunge una timbratura mancante (l'operaio non è riuscito a timbrare). */
export async function timbraturaManuale(body: {
  worker_id: string; tipo: "ENTRATA" | "USCITA"; timestamp: string; motivo: string;
}): Promise<Timbratura> {
  return api<Timbratura>("/timbrature/manuale", { method: "POST", body });
}

/** Ricostruisce una giornata intera sulle fasce concordate, per chi non ha timbrato nulla. */
/** Riscrive l'intera giornata: cancella le timbrature di quel giorno e mette queste. */
export async function riscriviGiornata(body: {
  worker_id: string;
  giorno: string;            // AAAA-MM-GG
  entrata: string;           // HH:MM
  uscita: string;            // HH:MM
  pausa_inizio?: string;
  pausa_fine?: string;
  motivo: string;
}): Promise<Timbratura[]> {
  return api<Timbratura[]>("/timbrature/giornata", { method: "POST", body });
}

export async function giornataStandard(worker_id: string, giorno: string, motivo: string): Promise<Timbratura[]> {
  return api<Timbratura[]>("/timbrature/giornata-standard", {
    method: "POST",
    body: { worker_id, giorno, motivo },
  });
}

// ---------------- Archivio Tecnico: rileggere e correggere ----------------

export type KnowledgeDocFull = {
  doc_id: string;
  title: string;
  content: string;
  chunks: number;
  created_by_name?: string | null;
  created_at: string;
};

/** Rilegge un documento per intero (i blocchi vengono ricuciti dal server). */
export async function leggiDocumento(docId: string): Promise<KnowledgeDocFull> {
  return api<KnowledgeDocFull>(`/knowledge/${docId}`);
}

/** Salva le correzioni: il testo viene reindicizzato da capo. */
export async function correggiDocumento(docId: string, title: string, content: string) {
  return api(`/knowledge/${docId}`, { method: "PUT", body: { title, content } });
}

/** Il titolare approva una commessa aperta dal meccanico o arrivata da STAR.
 *  Il lavoro puo essere gia partito: l'approvazione non e piu un permesso a iniziare. */
export async function approvaCommessa(orderId: string): Promise<WorkOrder> {
  return api<WorkOrder>(`/work-orders/${orderId}/approva`, { method: "POST" });
}

/** Fattura preparata: la commessa esce dalla lista dei sospesi. */
export async function segnaFatturata(orderId: string): Promise<WorkOrder> {
  return api<WorkOrder>(`/work-orders/${orderId}/fatturata`, { method: "POST" });
}

/* ---- Documenti dei fornitori: da qui arrivano i costi ---- */

export type RigaDocumento = {
  codice?: string | null;
  descrizione?: string | null;
  quantita?: number | null;
  costo_unitario?: number | null;
  listino?: number | null;
  importo?: number | null;
  targa?: string | null;
};

export type DocumentoFornitore = {
  id: string;
  fornitore?: string | null;
  codice_fornitore?: string | null;
  numero?: string | null;
  data_doc?: string | null;
  targa?: string | null;
  righe: RigaDocumento[];
  imponibile?: number | null;
  totale?: number | null;
  verifica?: { stato?: string; somma_netta?: number; imponibile?: number; scarto?: number } | null;
  caricato_da_nome?: string | null;
  created_at: string;
};

export async function listaDocumenti(targa?: string): Promise<DocumentoFornitore[]> {
  const qs = targa ? `?targa=${encodeURIComponent(targa)}` : "";
  return api<DocumentoFornitore[]>(`/documenti${qs}`);
}

export async function caricaDocumento(uri: string): Promise<DocumentoFornitore> {
  const token = await getToken();
  const form = new FormData();
  if (uri.startsWith("data:") || uri.startsWith("blob:")) {
    const blob = await (await fetch(uri)).blob();
    form.append("file", new File([blob], "documento.jpg", { type: blob.type || "image/jpeg" }));
  } else {
    // @ts-expect-error RN form data typing
    form.append("file", { uri, name: "documento.jpg", type: "image/jpeg" });
  }
  const res = await fetch(`${BASE_URL}/api/documenti`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `Errore ${res.status}`);
  return data as DocumentoFornitore;
}

export async function correggiDocumentoFornitore(
  id: string, body: { fornitore?: string; numero?: string; data_doc?: string; targa?: string; righe?: RigaDocumento[] }
): Promise<DocumentoFornitore> {
  return api<DocumentoFornitore>(`/documenti/${id}`, { method: "PATCH", body });
}

export async function eliminaDocumentoFornitore(id: string): Promise<void> {
  await api(`/documenti/${id}`, { method: "DELETE" });
}

export type Fornitore = { codice: string; nome: string; note?: string | null };

export async function listaFornitori(): Promise<Fornitore[]> {
  return api<Fornitore[]>("/fornitori");
}

export async function salvaFornitore(body: Fornitore): Promise<void> {
  await api("/fornitori", { method: "POST", body });
}

export type Preventivo = {
  disponibile: boolean;
  targa?: string;
  ricambi: {
    codice?: string; descrizione?: string; quantita: number; costo: number;
    ricarico: number; prezzo: number; totale: number; listino_fornitore?: number | null;
    /** true = prezzo preso dal catalogo perché la bolla non c'è */
    da_catalogo?: boolean;
    prezzo_vecchio_di_giorni?: number;
  }[];
  /** pezzi visti nelle foto ma senza costo: manca la bolla del fornitore */
  ricambi_senza_costo: { codice: string; descrizione?: string; marca?: string; quantita: number }[];
  ricambi_costo: number; ricambi_vendita: number; margine_ricambi: number;
  consumabili: { nome: string; quantita: number; unita?: string | null; prezzo: number; totale: number }[];
  consumabili_totale: number;
  ore: number; tariffa_oraria: number; manodopera: number;
  imponibile: number; iva_perc: number; iva: number; totale: number;
  mancanze: string[];
};

export async function preventivoCommessa(orderId: string): Promise<Preventivo> {
  return api<Preventivo>(`/work-orders/${orderId}/preventivo`);
}

/* ---- Avvisi su Telegram ---- */

export type TelegramChat = {
  chat_id: string;
  nome?: string | null;
  username?: string | null;
  attivo: boolean;
};

export type TelegramStato = {
  configurato: boolean;
  bot_username?: string | null;
  agganciati: TelegramChat[];
};

export async function telegramStato(): Promise<TelegramStato> {
  return api<TelegramStato>("/telegram/stato");
}

/** Registra chi ha premuto AVVIA sul bot. Da chiamare dopo aver scritto al bot. */
export async function telegramAggancia(): Promise<TelegramStato> {
  return api<TelegramStato>("/telegram/aggancia", { method: "POST" });
}

export async function telegramRimuovi(chatId: string): Promise<void> {
  await api(`/telegram/${chatId}`, { method: "DELETE" });
}

/** Rimette la commessa fra quelle da fatturare (spunta sbagliata). */
export async function annullaFatturata(orderId: string): Promise<WorkOrder> {
  return api<WorkOrder>(`/work-orders/${orderId}/annulla-fatturata`, { method: "POST" });
}
