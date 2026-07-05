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
