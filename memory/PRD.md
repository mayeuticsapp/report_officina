# PRD — Officina Meccanica (Workshop Manager)

## Vision
Un'app per officine meccaniche dove ogni operaio, con lo smartphone, fotografa e tracciа il lavoro (motore, pezzi, inizio/pausa/ripresa/fine). Un'AI (Claude Sonnet 4.5) interpreta i motivi delle pause e genera report immediati per il titolare. Il titolare gestisce tutto (operai, commesse, dashboard live) dallo stesso app.

## Stack
- **Frontend:** Expo (React Native) + Expo Router + TypeScript
- **Backend:** FastAPI + Motor (MongoDB) + JWT/bcrypt
- **AI:** Claude Sonnet 4.5 via Emergent Universal Key
- **Storage foto:** base64 nel documento evento (MVP)

## Roles
1. **Admin (Titolare)** — Crea operai e commesse, vede live dashboard, genera report AI, elimina.
2. **Worker (Operaio)** — Vede solo commesse a lui assegnate. Registra eventi START/PAUSE/RESUME/COMPLETE con motivo + foto.

## Features (MVP shipped)
### Backend
- `POST /api/auth/login` → `{token, user}`
- `GET /api/auth/me`
- **Users (admin):** `GET/POST/PUT/DELETE /api/users`
- **Work orders (commesse):** `GET/POST/PUT/DELETE /api/work-orders` (worker vede solo sue)
- **Events:** `POST /api/work-orders/{id}/events` (START/PAUSE/RESUME/COMPLETE + reason + photos_base64)
- **Live status:** `GET /api/workers/live-status` (admin) — status corrente di ogni operaio con `minutes_since`
- **Recent events:** `GET /api/events/recent?limit=N` (admin)
- **AI Report:** `GET /api/reports/daily` (admin) — Claude Sonnet 4.5 sintetizza gli eventi del giorno
- Ogni evento con motivo passa attraverso AI interpretation (Claude) per riassumere l'intento

### Frontend — Worker
- Login (`/`)
- **Home**: badge status live (AL LAVORO/IN PAUSA/LIBERO), job attivo con azioni giganti, lista commesse assegnate
- **Commesse**: filter chips (ATTIVE/TUTTE/COMPLETATE)
- **Order detail**: dettagli veicolo/cliente, timeline eventi con AI interpretation, bottone giganti START/PAUSE/RESUME/COMPLETE, modal con motivo + foto (camera/galleria)
- **Profile**: logout

### Frontend — Admin
- **Dashboard Live**: KPI (working/paused/idle), lista operai in tempo reale con alert se fermo >30min, eventi recenti, auto-refresh 15s
- **Commesse**: CRUD completo, assegnazione multi-operaio
- **Operai**: CRUD account (username/password/nome/role)
- **Report AI**: bottone "GENERA REPORT" → sintesi giornaliera Claude
- **Profile**: logout

## Design
Swiss & High-Contrast (design_guidelines.json): flat, 1px borders, no shadows, dominant black/white con status color (verde=active, giallo=paused, arancio=idle, rosso=stopped, blu=primary). Font system con weights 700-900 per titoli.

## Auth Model
JWT + bcrypt custom. Admin seeded on startup (`admin`/`admin123`). Nessun self-signup — solo l'admin crea operai.

## Data
- MongoDB collections: `users`, `work_orders`, `work_events` (immutabile, append-only timeline)
- IDs UUID v4 stringa
- Foto: base64 inline

## Non-goals (MVP)
- QR/NFC scan (usa selezione manuale commessa)
- Offline sync
- Push notifications
- Vector DB / memoria commesse
- Multi-tenant

## Next iterations
- QR/barcode scan per apertura veloce commessa
- Export PDF report
- Fascia oraria + calcolo ore lavorate per operaio
- Notifiche in-app admin quando operaio fermo >30 min

## v2 — AI voice dialogue

**Backend additions:**
- `POST /api/vision/plate` — Claude Sonnet 4.5 Vision OCR di una targa italiana da foto (base64). Soft-fail 200 con `plate: null` se immagine non leggibile.
- `POST /api/audio/transcribe` — Whisper-1 (multipart upload). Formati supportati: m4a/mp3/mp4/mpeg/mpga/wav/webm. Lingua: italiano.
- `POST /api/work-orders/{id}/voice-turn` — Multi-turn dialogo con Claude Sonnet 4.5. Riceve testo dell'operaio, risponde brevemente, e in un JSON block emette la scheda_tecnica strutturata aggiornata (marca/modello/anno/motore/km/lavori_fatti/lavori_da_fare/ricambi_necessari/note). Il backend fa merge intelligente: stringhe sostituite solo se non-vuote, liste accumulate senza duplicati.
- `GET /api/work-orders/{id}/conversation` — turni completi + scheda corrente.
- Nuova collection MongoDB: `conversations` (una per commessa, `turns` array con `role/text/timestamp`).
- Extended `WorkOrder` model con `scheda_tecnica: SchedaTecnica`.

**Frontend additions:**
- `src/components/VoiceChat.tsx` — componente riutilizzabile:
  - Card SCHEDA TECNICA AI live (marca, modello, anno, motore, km + liste lavori fatti / da fare / ricambi).
  - Chat bubbles operaio (nero) vs AI (grigio con etichetta AI).
  - Input di testo + bottone invio.
  - Bottone microfono "tieni-premuto-per-registrare" (expo-audio + Whisper-1) con animazione pulse rossa.
  - Bottone SCAN TARGA (camera → Claude Vision → auto-invia turno "La targa è XXX").
  - `readOnly` prop per la vista admin.
- Integrato in `/(worker)/order/[id]` (interattivo).
- Nuovo `/(admin)/order/[id]` — vista read-only con dettagli, scheda AI, dialogo, timeline eventi. Accessibile con bottone VEDI dalla lista commesse admin.
- Permessi microfono aggiunti in `app.json` (iOS/Android).

## v3 — Migrazione a Mistral AI (SHIPPED)

Rimossi TUTTI i riferimenti ad Anthropic Claude e OpenAI Whisper. L'intera app ora gira su Mistral.

**Modelli utilizzati:**
- `mistral-large-latest` — dialogo AI, interpretazione motivi pausa, report giornaliero (con JSON mode per la scheda tecnica strutturata)
- `mistral-ocr-latest` — OCR targhe italiane (via `client.ocr.process_async()`)
- `voxtral-mini-latest` — trascrizione audio italiano (via `client.audio.transcriptions.complete_async()`)

**Cambiamenti:**
- Dipendenza `emergentintegrations` non più importata in `server.py`
- Aggiunta `mistralai>=2.5.2` a `requirements.txt`
- `.env`: rimosso `EMERGENT_LLM_KEY`, aggiunto `MISTRAL_API_KEY` (+ opzionali `MISTRAL_TEXT_MODEL`, `MISTRAL_OCR_MODEL`, `MISTRAL_STT_MODEL`)
- Client Mistral condiviso a livello modulo (`mistral_client`)
- Zero modifiche al frontend: contratto JSON degli endpoint invariato
- Costi stimati per commessa completa: dialogo ~€0.002/turno, OCR ~€0.001/targa, Voxtral ~€0.001/minuto
