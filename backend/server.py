"""
Officina Meccanica - Backend API
FastAPI + PostgreSQL (asyncpg) + JWT + Mistral AI
"""
import os
import uuid
import asyncio
import logging
import json
import re
import base64
import tempfile
import io
import math
from pathlib import Path
from datetime import datetime, date, timezone, timedelta
from zoneinfo import ZoneInfo
from typing import List, Optional, Literal

import asyncpg
from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, UploadFile, File, Header
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import OAuth2PasswordBearer
from starlette.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field
import jwt
import bcrypt

import ai  # unico punto di contatto col modello AI (vedi ai.py)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------- Config ----------------
DATABASE_URL = os.environ["DATABASE_URL"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_DAYS = int(os.environ.get("JWT_EXPIRES_DAYS", "7"))
# Config AI (modelli, prompt, client) centralizzata in ai.py
SEED_ADMIN_USERNAME = os.environ.get("SEED_ADMIN_USERNAME", "admin")
SEED_ADMIN_PASSWORD = os.environ.get("SEED_ADMIN_PASSWORD", "admin123")
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", str(ROOT_DIR / "uploads")))
MAX_PHOTO_BYTES = int(os.environ.get("MAX_PHOTO_BYTES", str(15 * 1024 * 1024)))  # 15MB
MAX_VIDEO_BYTES = int(os.environ.get("MAX_VIDEO_BYTES", str(60 * 1024 * 1024)))  # 60MB
# Openapi.com: riserva futura per targhe fuori anagrafica STAR (token sandbox in .env, non usato)
OPENAPI_TOKEN = os.environ.get("OPENAPI_TOKEN", "")
OPENAPI_BASE_URL = os.environ.get("OPENAPI_BASE_URL", "https://automotive.openapi.com")
OMNIUS_KEY = os.environ.get("OMNIUS_KEY", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://app.autoservicevalente.it")
VAPID_PRIVATE_KEY_FILE = os.environ.get("VAPID_PRIVATE_KEY_FILE", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_SUB = os.environ.get("VAPID_SUB", "mailto:info@example.com")

# Telegram: avvisa i titolari a lavoro completato, anche ad app chiusa.
# Senza token il sistema resta zitto e non fallisce mai: e' un canale in piu', non un requisito.
#
# Ogni titolare si aggancia in CHAT PRIVATA col bot, non in un gruppo: nei gruppi
# Telegram attiva la "modalita privacy" e il bot non vedrebbe i messaggi, quindi non
# potremmo mai ricavarne l'identificativo. Nelle chat private invece riceve tutto.
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("officina")

# ---------------- App ----------------
app = FastAPI(title="Officina Meccanica API")
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

# DB pool (set on startup)
pool: asyncpg.Pool = None


# ---------------- DB Helpers ----------------
async def get_pool() -> asyncpg.Pool:
    return pool


async def fetchrow(query: str, *args) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, *args)
        return dict(row) if row else None


async def fetch(query: str, *args) -> List[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *args)
        return [dict(r) for r in rows]


async def execute(query: str, *args):
    async with pool.acquire() as conn:
        await conn.execute(query, *args)


# ---------------- Helpers ----------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_dt(s: str) -> datetime:
    """Parse ISO8601 datetime (accetta suffisso Z). Errore 400 se malformato."""
    try:
        dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        raise HTTPException(status_code=400, detail=f"updated_since non valido (ISO8601 atteso): {s}")


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, username: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "exp": now_utc() + timedelta(days=JWT_EXPIRES_DAYS),
        "iat": now_utc(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def _user_from_token(token: Optional[str]) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Non autenticato")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Sessione scaduta")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token non valido")
    user = await fetchrow(
        "SELECT id, username, full_name, role, created_at, cartellino_attivo FROM users WHERE id=$1",
        payload["sub"]
    )
    if not user:
        raise HTTPException(status_code=401, detail="Utente non trovato")
    return user


async def get_current_user(token: Optional[str] = Depends(oauth2)) -> dict:
    return await _user_from_token(token)


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Solo amministratori")
    return user


# ---------------- Models ----------------
Role = Literal["admin", "worker"]
# KM non cambia lo stato della commessa: serve solo a correggere un chilometraggio
# sbagliato, lasciando scritto il perché.
EventType = Literal["START", "PAUSE", "RESUME", "COMPLETE", "KM"]
OrderStatus = Literal["pending", "open", "in_progress", "paused", "completed"]

# Segnaposto che significano "veicolo non ancora identificato": non sono dati,
# e all'AI non vanno passati come se lo fossero.
PLACEHOLDER_VEICOLO = ("", "DA IDENTIFICARE", "VEICOLO DA DEFINIRE", "DA DEFINIRE", "DA INSERIRE")

# ---- Cartellino presenze ----
# Orario concordato con Roberto:
#   lunedì–venerdì  8:30–13:00 + 14:30–18:30 = 8 ore e mezza  (510 min)
#   sabato          8:00–13:30               = 5 ore e mezza  (330 min)
#   domenica        chiuso: chi viene mette tutto a credito   (0 min)
# Il conto si fa sul TOTALE della giornata, non sulle fasce: così il recupero
# funziona comunque lo faccia (entrando dopo, uscendo prima a pranzo o la sera).
TARGET_FERIALE = 510
TARGET_SABATO = 330
# Sfrido fisiologico, in entrata e in uscita: gli scarti fino a questa soglia non
# diventano ne' credito ne' debito. Oltre, conta solo l'eccedenza (18:45 su un'uscita
# alle 18:30 = 5 minuti maturati).
TOLLERANZA_MINUTI = int(os.environ.get("TOLLERANZA_MINUTI", "10"))
RAGGIO_OFFICINA_M = 500


def _target_minuti(giorno: date) -> int:
    """Quanto deve fare quel giorno. weekday(): 0=lunedì … 5=sabato, 6=domenica."""
    g = giorno.weekday()
    if g == 6:
        return 0
    return TARGET_SABATO if g == 5 else TARGET_FERIALE
PLACEHOLDER_CLIENTE = ("", "DA INSERIRE", "CLIENTE DA DEFINIRE")


class TimbraturaIn(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[float] = None


class Timbratura(BaseModel):
    id: str
    worker_id: str
    worker_name: str
    tipo: Literal["ENTRATA", "USCITA"]
    timestamp: datetime
    giorno: str
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[int] = None
    distanza_m: Optional[int] = None
    fuori_zona: bool = False
    posizione_assente: bool = False
    corretta_da_nome: Optional[str] = None
    motivo_correzione: Optional[str] = None


class GiornataOut(BaseModel):
    giorno: str
    minuti_presenza: int
    minuti_target: int
    differenza: int                 # + straordinario da recuperare, − da restituire
    differenza_lorda: int = 0       # prima della tolleranza: quanto ha fatto davvero
    tolleranza_applicata: int = 0   # minuti assorbiti dalla tolleranza
    incompleta: bool                # manca una timbratura di uscita
    dentro_adesso: bool
    timbrature: List[Timbratura]


class CartellinoOut(BaseModel):
    worker_id: str
    worker_name: str
    giornate: List[GiornataOut]
    saldo_minuti: int               # il monte ore a recupero, cumulativo
    giorni_incompleti: int


class UserPublic(BaseModel):
    id: str
    username: str
    full_name: str
    role: Role
    created_at: datetime
    # chi non timbra il cartellino (es. chi ha un accordo diverso) non lo vede proprio
    cartellino_attivo: bool = True


class UserCreate(BaseModel):
    username: str
    password: str
    full_name: str
    role: Role = "worker"


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Role] = None
    cartellino_attivo: Optional[bool] = None


class LoginIn(BaseModel):
    username: str
    password: str


class LoginOut(BaseModel):
    token: str
    user: UserPublic


class WorkOrderCreate(BaseModel):
    plate: str
    vin: Optional[str] = None
    customer: str
    vehicle: str
    description: str
    assigned_worker_ids: List[str] = Field(default_factory=list)


class WorkOrderPropose(BaseModel):
    plate: str
    vin: Optional[str] = None
    customer: Optional[str] = None   # il meccanico spesso non lo sa: arriva da STAR
    vehicle: Optional[str] = None    # idem
    description: str


class PrintOrdersIn(BaseModel):
    order_ids: List[str]


class SchedaTecnica(BaseModel):
    marca: Optional[str] = None
    modello: Optional[str] = None
    anno: Optional[str] = None
    motore: Optional[str] = None
    km: Optional[str] = None
    lavori_fatti: List[str] = Field(default_factory=list)
    lavori_da_fare: List[str] = Field(default_factory=list)
    ricambi_necessari: List[str] = Field(default_factory=list)
    ricambi_sostituiti: List[str] = Field(default_factory=list)  # pezzi VERAMENTE cambiati (per la fattura)
    note: Optional[str] = None
    # Righe strutturate da STAR (ricambi/manodopera con codice, qta, tipo, prezzo).
    # I prezzi sono dati sensibili: vengono rimossi per i non-admin (vedi _strip_prices_for).
    righe: List[dict] = Field(default_factory=list)
    # Consumabili dichiarati alla chiusura (olio e simili): vengono dal fusto
    # dell'officina, non da una bolla, quindi li scrive il meccanico.
    consumabili: List[dict] = Field(default_factory=list)


class WorkOrderUpdate(BaseModel):
    plate: Optional[str] = None
    vin: Optional[str] = None
    customer: Optional[str] = None
    vehicle: Optional[str] = None
    description: Optional[str] = None
    assigned_worker_ids: Optional[List[str]] = None
    status: Optional[OrderStatus] = None


class WorkOrder(BaseModel):
    id: str
    plate: str
    vin: Optional[str] = None
    customer: str
    vehicle: str
    description: str
    assigned_worker_ids: List[str]
    status: OrderStatus
    scheda_tecnica: SchedaTecnica = Field(default_factory=SchedaTecnica)
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    minutes_calculated: Optional[int] = None       # ore dai timbri (registro grezzo)
    minutes_effective: Optional[int] = None        # ore corrette dal meccanico (per la fattura)
    minutes_effective_reason: Optional[str] = None
    # approvazione: separata dallo stato del lavoro. NULL = ancora da approvare,
    # ma il meccanico puo gia lavorarci.
    approvata_il: Optional[datetime] = None
    approvata_da_nome: Optional[str] = None
    # fatturazione: NULL = completata ma ancora da fatturare, resta nella lista dei sospesi
    fatturata_il: Optional[datetime] = None
    fatturata_da_nome: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class WorkEventCreate(BaseModel):
    type: EventType
    reason: Optional[str] = None
    photos_base64: List[str] = Field(default_factory=list)
    km: Optional[str] = None  # chilometraggio del veicolo: si chiede su INIZIA
    # se su INIZIA il meccanico non può leggere il contachilometri (auto già sul
    # ponte, arrivata col carroattrezzi…) scrive qui il perché e li mette alla fine
    km_deferred_reason: Optional[str] = None
    # ore da mettere in fattura, confermate dal meccanico su COMPLETA (obbligatorie)
    minutes_effective: Optional[int] = None
    # foto del libretto, obbligatoria su INIZIA (data URL o base64 puro)
    libretto_base64: Optional[str] = None
    # litri di olio messi nel motore: non arrivano da nessuna bolla, stanno nel fusto,
    # e senza questo dato il preventivo esce sotto di circa il 15% su un tagliando
    olio_litri: Optional[float] = None


class WorkEvent(BaseModel):
    id: str
    work_order_id: str
    worker_id: str
    worker_username: str
    worker_full_name: str
    type: EventType
    reason: Optional[str] = None
    photos_base64: List[str] = Field(default_factory=list)
    timestamp: datetime
    ai_interpretation: Optional[str] = None
    km: Optional[str] = None
    km_deferred_reason: Optional[str] = None


class LiveWorkerStatus(BaseModel):
    worker_id: str
    username: str
    full_name: str
    current_status: Literal["working", "paused", "idle"]
    current_work_order_id: Optional[str] = None
    current_work_order_label: Optional[str] = None
    since: Optional[datetime] = None
    minutes_since: Optional[int] = None
    last_reason: Optional[str] = None


# ---- Report models ----
class WorkerOrderStats(BaseModel):
    order_id: str
    plate: str
    vehicle: str
    customer: str
    events_count: int
    minutes_worked: int
    started_at: Optional[datetime] = None
    last_event_at: Optional[datetime] = None


class WorkerDailyStats(BaseModel):
    worker_id: str
    username: str
    full_name: str
    events_count: int
    minutes_worked: int
    orders: List[WorkerOrderStats]


class DailyReportOut(BaseModel):
    date: str
    filter_worker_ids: List[str]
    workers: List[WorkerDailyStats]
    total_events: int
    total_minutes: int
    orders_touched: int
    narrative: str
    generated_at: datetime


# ---- Voice chat models ----
class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    timestamp: datetime
    worker_id: Optional[str] = None
    worker_full_name: Optional[str] = None
    edited_at: Optional[datetime] = None


class VoiceTurnIn(BaseModel):
    user_text: str


class VoiceTurnOut(BaseModel):
    assistant_text: str
    scheda_tecnica: SchedaTecnica
    turn: ConversationTurn


class ConversationOut(BaseModel):
    work_order_id: str
    scheda_tecnica: SchedaTecnica
    turns: List[ConversationTurn]


class PlateOcrIn(BaseModel):
    image_base64: str


class PlateOcrOut(BaseModel):
    plate: Optional[str] = None
    raw: str


class TranscribeOut(BaseModel):
    text: str


# ---------------- DB row helpers ----------------
def _scheda_for_user(scheda: SchedaTecnica, user: dict) -> SchedaTecnica:
    """I prezzi delle righe sono visibili solo all'admin: per gli altri li rimuove."""
    if user.get("role") == "admin" or not scheda.righe:
        return scheda
    righe = [{k: v for k, v in r.items() if k != "prezzo"} for r in scheda.righe]
    return scheda.model_copy(update={"righe": righe})


def _workorder_for_user(wo: WorkOrder, user: dict) -> WorkOrder:
    if user.get("role") == "admin" or not wo.scheda_tecnica.righe:
        return wo
    return wo.model_copy(update={"scheda_tecnica": _scheda_for_user(wo.scheda_tecnica, user)})


def row_to_workorder(row: dict) -> WorkOrder:
    scheda = row.get("scheda_tecnica") or {}
    if isinstance(scheda, str):
        scheda = json.loads(scheda)
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    return WorkOrder(
        id=row["id"],
        plate=row["plate"],
        vin=row.get("vin"),
        customer=row["customer"],
        vehicle=row["vehicle"],
        description=row["description"],
        assigned_worker_ids=worker_ids,
        status=row["status"],
        scheda_tecnica=SchedaTecnica(**scheda),
        created_by=row.get("created_by"),
        created_by_name=row.get("created_by_name"),
        minutes_effective=row.get("minutes_effective"),
        minutes_effective_reason=row.get("minutes_effective_reason"),
        approvata_il=row.get("approvata_il"),
        approvata_da_nome=row.get("approvata_da_nome"),
        fatturata_il=row.get("fatturata_il"),
        fatturata_da_nome=row.get("fatturata_da_nome"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def row_to_event(row: dict) -> WorkEvent:
    photos = row.get("photos_base64") or []
    if isinstance(photos, str):
        photos = json.loads(photos)
    return WorkEvent(
        id=row["id"],
        work_order_id=row["work_order_id"],
        worker_id=row["worker_id"],
        worker_username=row["worker_username"],
        worker_full_name=row["worker_full_name"],
        type=row["type"],
        reason=row.get("reason"),
        photos_base64=photos,
        timestamp=row["timestamp"],
        ai_interpretation=row.get("ai_interpretation"),
        km=row.get("km"),
        km_deferred_reason=row.get("km_deferred_reason"),
    )


# ---------------- Startup ----------------
@app.on_event("startup")
async def startup():
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)

    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'worker',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS work_orders (
                id TEXT PRIMARY KEY,
                plate TEXT NOT NULL,
                vin TEXT,
                customer TEXT NOT NULL,
                vehicle TEXT NOT NULL,
                description TEXT NOT NULL,
                assigned_worker_ids JSONB NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'open',
                scheda_tecnica JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS work_events (
                id TEXT PRIMARY KEY,
                work_order_id TEXT NOT NULL,
                worker_id TEXT NOT NULL,
                worker_username TEXT NOT NULL,
                worker_full_name TEXT NOT NULL,
                type TEXT NOT NULL,
                reason TEXT,
                photos_base64 JSONB NOT NULL DEFAULT '[]',
                timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ai_interpretation TEXT
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                work_order_id TEXT PRIMARY KEY,
                turns JSONB NOT NULL DEFAULT '[]',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by TEXT")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by_name TEXT")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS star_doc_id TEXT")
        # Ore effettive corrette dal meccanico (per la fattura); le calcolate restano nei timbri
        # Commessa nata da un appuntamento del planning: la chiave è giorno|ora|targa,
        # perché gli appuntamenti di STAR non hanno un id stabile (lo snapshot viene
        # riscritto da zero a ogni invio di Omnius). Unica: due click non fanno due commesse.
        # L'approvazione era incastrata nello stato del lavoro: una commessa "pending"
        # non poteva nemmeno partire. Ora sono due cose separate — il lavoro va avanti,
        # l'approvazione arriva quando il titolare la vede.
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS approvata_il TIMESTAMPTZ")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS approvata_da_nome TEXT")
        await conn.execute(
            "UPDATE work_orders SET approvata_il = created_at "
            "WHERE approvata_il IS NULL AND status <> 'pending'")
        # le vecchie in attesa: restano da approvare, ma adesso si possono lavorare
        await conn.execute("UPDATE work_orders SET status='open' WHERE status='pending'")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS planning_key TEXT")
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_planning_key "
            "ON work_orders (planning_key) WHERE planning_key IS NOT NULL"
        )
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS minutes_effective INTEGER")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS minutes_effective_reason TEXT")
        # Fatturazione: una commessa completata resta in lista finche' il titolare non la spunta.
        # Serve perche' una notifica si puo' perdere, una lista no.
        # Quando Omnius ha ritirato il preventivo e l'ha caricato su STAR: serve a non
        # riconsegnarglielo a ogni giro, e a sapere cosa e' gia' arrivato dall'altra parte.
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS preventivo_inviato_il TIMESTAMPTZ")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS preventivo_star_id TEXT")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fatturata_il TIMESTAMPTZ")
        await conn.execute("ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fatturata_da_nome TEXT")
        # Fornitori: il titolare scrive a penna F1, F2... sul documento per dire da chi arriva.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS fornitori (
                codice TEXT PRIMARY KEY,
                nome TEXT NOT NULL,
                note TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        # Chi stampa i prezzi IVA inclusa e chi no: sbagliarlo gonfia il preventivo del 22%
        await conn.execute(
            "ALTER TABLE fornitori ADD COLUMN IF NOT EXISTS iva_inclusa BOOLEAN NOT NULL DEFAULT FALSE")
        for cod, nome, iva_inc in (("F1", "GR GROUP", False), ("F2", "CDR", True)):
            await conn.execute(
                """INSERT INTO fornitori (codice, nome, iva_inclusa) VALUES ($1,$2,$3)
                   ON CONFLICT (codice) DO UPDATE SET iva_inclusa=$3""",
                cod, nome, iva_inc)

        # I documenti dei fornitori fotografati: e' da qui che arrivano i COSTI, e senza
        # costi non si calcola nessun preventivo.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS documenti_fornitore (
                id TEXT PRIMARY KEY,
                fornitore TEXT,
                codice_fornitore TEXT,
                numero TEXT,
                data_doc DATE,
                targa TEXT,
                righe JSONB NOT NULL DEFAULT '[]',
                imponibile NUMERIC(10,2),
                totale NUMERIC(10,2),
                verifica JSONB,
                content_type TEXT,
                caricato_da TEXT,
                caricato_da_nome TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_documenti_targa ON documenti_fornitore (upper(targa))")

        # Catalogo ricambi: il prezzo di riferimento quando la bolla non c'e' — pezzo preso
        # dal magazzino, o bolla non ancora caricata. Si riempie da solo a ogni documento
        # letto, cosi' invece di invecchiare da fermo si aggiorna lavorando.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS catalogo_ricambi (
                codice_norm TEXT PRIMARY KEY,
                codice TEXT NOT NULL,
                descrizione TEXT,
                marca TEXT,
                costo NUMERIC(10,2),
                fornitore TEXT,
                origine TEXT NOT NULL DEFAULT 'bolla',
                aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        # Il prezzo di vendita deciso dal titolare, quando c'e': vale piu' di qualsiasi
        # ricarico calcolato, perche' e' la sua scelta commerciale su quell'articolo.
        await conn.execute(
            "ALTER TABLE catalogo_ricambi ADD COLUMN IF NOT EXISTS prezzo_vendita NUMERIC(10,2)")

        # Le regole commerciali del titolare: ricarico a scaglioni, tariffa oraria, consumabili.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS impostazioni_prezzi (
                id INT PRIMARY KEY DEFAULT 1,
                scaglioni JSONB NOT NULL,
                tariffa_oraria NUMERIC(10,2) NOT NULL DEFAULT 37,
                iva NUMERIC(5,2) NOT NULL DEFAULT 22,
                consumabili JSONB NOT NULL DEFAULT '[]',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            INSERT INTO impostazioni_prezzi (id, scaglioni, tariffa_oraria, iva, consumabili)
            VALUES (1, $1::jsonb, 37, 22, $2::jsonb) ON CONFLICT (id) DO NOTHING
        """,
            json.dumps([
                {"fino_a": 20, "ricarico": 200},
                {"fino_a": 60, "ricarico": 150},
                {"fino_a": None, "ricarico": 100},
            ]),
            json.dumps([
                # prezzo gia' finito al cliente: sull'olio non si applica ricarico
                {"nome": "Olio motore", "unita": "litri", "prezzo": 16.00},
            ]))
        # se le impostazioni esistevano gia' col vecchio schema, si aggiorna l'olio
        await conn.execute("""
            UPDATE impostazioni_prezzi
               SET consumabili = $1::jsonb
             WHERE id = 1 AND NOT (consumabili @> '[{"nome":"Olio motore","prezzo":16.00}]'::jsonb)
        """, json.dumps([{"nome": "Olio motore", "unita": "litri", "prezzo": 16.00}]))

        # Storico del planning: officina_planning tiene una riga sola, sovrascritta a ogni
        # invio di Omnius, quindi i giorni passati sparivano. Qui ogni giorno resta.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS planning_storico (
                giorno DATE PRIMARY KEY,
                appuntamenti JSONB NOT NULL DEFAULT '[]',
                aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        # Chi riceve gli avvisi su Telegram. Una riga per titolare, chat privata col bot.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS telegram_chats (
                chat_id TEXT PRIMARY KEY,
                nome TEXT,
                username TEXT,
                aggiunto_il TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                attivo BOOLEAN NOT NULL DEFAULT TRUE
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS plate_lookup_requests (
                id TEXT PRIMARY KEY,
                work_order_id TEXT NOT NULL,
                plate TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                requested_by_name TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                answered_at TIMESTAMPTZ
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_plate_lookup_pending ON plate_lookup_requests (status, created_at)"
        )
        # Planning officina: snapshot unico spedito da Omnius (fonte: STAR)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS officina_planning (
                id INT PRIMARY KEY DEFAULT 1,
                aggiornato TEXT,
                giorni_coperti INT,
                appuntamenti JSONB NOT NULL DEFAULT '[]',
                received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_star_doc_id ON work_orders (star_doc_id) WHERE star_doc_id IS NOT NULL"
        )
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS order_photos (
                id TEXT PRIMARY KEY,
                work_order_id TEXT NOT NULL,
                uploaded_by TEXT NOT NULL,
                uploaded_by_name TEXT NOT NULL,
                content_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_order_photos_order ON order_photos (work_order_id, created_at)"
        )
        # Didascalia AI della foto (Mistral vision la 'vede' una volta, poi entra nella memoria)
        await conn.execute("ALTER TABLE order_photos ADD COLUMN IF NOT EXISTS caption TEXT")
        # Tipo di foto: "libretto" è quella obbligatoria all'inizio del lavoro
        await conn.execute("ALTER TABLE order_photos ADD COLUMN IF NOT EXISTS kind TEXT")
        # campi del libretto estratti dall'OCR (alimentazione, motore, euro, gomme…)
        await conn.execute("ALTER TABLE order_photos ADD COLUMN IF NOT EXISTS dati JSONB")
        # Messaggi commessa (admin <-> operai) + notifiche push
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS order_messages (
                id TEXT PRIMARY KEY,
                work_order_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                sender_role TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_order_messages_order ON order_messages (work_order_id, created_at)"
        )
        await conn.execute("ALTER TABLE order_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ")
        # Cartellino presenze: timbrature con posizione
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS timbrature (
                id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL,
                worker_name TEXT NOT NULL,
                tipo TEXT NOT NULL,
                timestamp TIMESTAMPTZ NOT NULL,
                giorno DATE NOT NULL,
                lat DOUBLE PRECISION,
                lon DOUBLE PRECISION,
                accuracy_m INTEGER,
                distanza_m INTEGER,
                fuori_zona BOOLEAN NOT NULL DEFAULT FALSE,
                posizione_assente BOOLEAN NOT NULL DEFAULT FALSE,
                corretta_da TEXT,
                corretta_da_nome TEXT,
                corretta_il TIMESTAMPTZ,
                motivo_correzione TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_timbrature_worker_giorno ON timbrature (worker_id, giorno)"
        )
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS officina_posizione (
                id INTEGER PRIMARY KEY,
                lat DOUBLE PRECISION NOT NULL,
                lon DOUBLE PRECISION NOT NULL,
                raggio_m INTEGER NOT NULL DEFAULT 500,
                impostata_da_nome TEXT,
                impostata_il TIMESTAMPTZ
            )
        """)
        await conn.execute(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS cartellino_attivo BOOLEAN NOT NULL DEFAULT TRUE")
        await conn.execute("ALTER TABLE work_events ADD COLUMN IF NOT EXISTS km TEXT")
        await conn.execute("ALTER TABLE work_events ADD COLUMN IF NOT EXISTS km_deferred_reason TEXT")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS message_reads (
                user_id TEXT NOT NULL,
                work_order_id TEXT NOT NULL,
                last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, work_order_id)
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        # Memoria storica (RAG): estensione pgvector + tabella embeddings dei casi completati
        try:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS case_embeddings (
                    work_order_id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    embedding vector(1024) NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_case_embeddings_vec ON case_embeddings USING hnsw (embedding vector_cosine_ops)"
            )
            # Archivio Tecnico: documentazione ufficiale caricata dal titolare (manuali, tabelle, bollettini)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS knowledge_docs (
                    id TEXT PRIMARY KEY,
                    doc_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    chunk_idx INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    embedding vector(1024) NOT NULL,
                    created_by_name TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_knowledge_docs_vec ON knowledge_docs USING hnsw (embedding vector_cosine_ops)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_knowledge_docs_doc ON knowledge_docs (doc_id)"
            )
        except Exception as e:
            logger.warning(f"pgvector non disponibile, memoria storica disattivata: {e}")
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

        existing = await conn.fetchrow("SELECT id FROM users WHERE username=$1", SEED_ADMIN_USERNAME)
        if not existing:
            await conn.execute(
                "INSERT INTO users (id, username, password_hash, full_name, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
                str(uuid.uuid4()), SEED_ADMIN_USERNAME, hash_password(SEED_ADMIN_PASSWORD),
                "Titolare", "admin", now_utc()
            )
            logger.info(f"Admin creato: {SEED_ADMIN_USERNAME}")

    # Backfill in background: indicizza i casi completati che mancano dalla memoria storica
    asyncio.create_task(_backfill_case_embeddings())


@app.on_event("shutdown")
async def shutdown():
    if pool:
        await pool.close()


# ---------------- Routes ----------------
@api.get("/")
async def root():
    return {"message": "Officina Meccanica API", "status": "ok"}


# ---- Auth ----
@api.post("/auth/login", response_model=LoginOut)
async def login(body: LoginIn):
    user = await fetchrow("SELECT * FROM users WHERE username=$1", body.username)
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenziali non valide")
    token = create_token(user["id"], user["username"], user["role"])
    public = UserPublic(**{k: user[k] for k in ("id", "username", "full_name", "role", "created_at")},
                        cartellino_attivo=user.get("cartellino_attivo", True))
    return LoginOut(token=token, user=public)


class PasswordChangeIn(BaseModel):
    old_password: str
    new_password: str


@api.post("/auth/change-password")
async def change_password(body: PasswordChangeIn, user: dict = Depends(get_current_user)):
    row = await fetchrow("SELECT password_hash FROM users WHERE id=$1", user["id"])
    if not row or not verify_password(body.old_password, row["password_hash"]):
        raise HTTPException(status_code=403, detail="La password attuale non è corretta")
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="La nuova password deve avere almeno 6 caratteri")
    await execute("UPDATE users SET password_hash=$1 WHERE id=$2", hash_password(body.new_password), user["id"])
    return {"ok": True}


@api.get("/auth/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)):
    return UserPublic(**user)


# ---- Users (admin only) ----
@api.get("/users", response_model=List[UserPublic])
async def list_users(user: dict = Depends(require_admin)):
    rows = await fetch("SELECT id, username, full_name, role, created_at, cartellino_attivo "
                       "FROM users ORDER BY created_at DESC LIMIT 500")
    return [UserPublic(**r) for r in rows]


@api.post("/users", response_model=UserPublic)
async def create_user(body: UserCreate, admin: dict = Depends(require_admin)):
    exists = await fetchrow("SELECT id FROM users WHERE username=$1", body.username)
    if exists:
        raise HTTPException(status_code=400, detail="Username già in uso")
    new_id = str(uuid.uuid4())
    created_at = now_utc()
    await execute(
        "INSERT INTO users (id, username, password_hash, full_name, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        new_id, body.username, hash_password(body.password), body.full_name, body.role, created_at
    )
    return UserPublic(id=new_id, username=body.username, full_name=body.full_name, role=body.role, created_at=created_at)


@api.put("/users/{user_id}", response_model=UserPublic)
async def update_user(user_id: str, body: UserUpdate, admin: dict = Depends(require_admin)):
    parts = []
    vals = []
    i = 1
    if body.full_name is not None:
        parts.append(f"full_name=${i}"); vals.append(body.full_name); i += 1
    if body.password:
        parts.append(f"password_hash=${i}"); vals.append(hash_password(body.password)); i += 1
    if body.role is not None:
        parts.append(f"role=${i}"); vals.append(body.role); i += 1
    if body.cartellino_attivo is not None:
        parts.append(f"cartellino_attivo=${i}"); vals.append(body.cartellino_attivo); i += 1
    if not parts:
        raise HTTPException(status_code=400, detail="Nessun campo da aggiornare")
    vals.append(user_id)
    row = await fetchrow(
        f"UPDATE users SET {', '.join(parts)} WHERE id=${i} "
        f"RETURNING id, username, full_name, role, created_at, cartellino_attivo",
        *vals
    )
    if not row:
        raise HTTPException(status_code=404, detail="Utente non trovato")
    return UserPublic(**row)


@api.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Non puoi eliminare te stesso")
    async with pool.acquire() as conn:
        res = await conn.execute("DELETE FROM users WHERE id=$1", user_id)
    if res == "DELETE 0":
        raise HTTPException(status_code=404, detail="Utente non trovato")
    return {"ok": True}


# ---- Work Orders ----
@api.get("/work-orders", response_model=List[WorkOrder])
async def list_work_orders(q: Optional[str] = None, worker: Optional[str] = None,
                           user: dict = Depends(get_current_user)):
    """q = ricerca libera (targa, cliente, veicolo, lavoro, scheda, NOME DEL MECCANICO).
    worker = filtro secco per id meccanico: solo le auto assegnate a lui, senza
    che un cliente omonimo finisca nei risultati."""
    conds = []
    vals: list = []
    if user["role"] == "worker":
        vals.append(json.dumps([user["id"]]))
        conds.append(f"assigned_worker_ids @> ${len(vals)}::jsonb")
    elif worker and worker.strip():
        vals.append(json.dumps([worker.strip()]))
        conds.append(f"assigned_worker_ids @> ${len(vals)}::jsonb")
    if q and q.strip():
        termine = q.strip()
        vals.append(f"%{termine}%")
        i = len(vals)
        oppure = [
            f"plate ILIKE ${i}", f"customer ILIKE ${i}", f"vehicle ILIKE ${i}",
            f"description ILIKE ${i}", f"scheda_tecnica::text ILIKE ${i}",
        ]
        # Si cerca anche per NOME DEL MECCANICO: "giuseppe" tira su le auto che ha lui.
        # I nomi non stanno sulla commessa (ci sono gli id), quindi prima li traduciamo.
        simili = await fetch(
            "SELECT id FROM users WHERE role='worker' AND (full_name ILIKE $1 OR username ILIKE $1)",
            f"%{termine}%",
        )
        for u in simili:
            vals.append(json.dumps([u["id"]]))
            oppure.append(f"assigned_worker_ids @> ${len(vals)}::jsonb")
        conds.append("(" + " OR ".join(oppure) + ")")
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = await fetch(f"SELECT * FROM work_orders {where} ORDER BY created_at DESC LIMIT 500", *vals)
    return [_workorder_for_user(row_to_workorder(r), user) for r in rows]


@api.post("/work-orders", response_model=WorkOrder)
async def create_work_order(body: WorkOrderCreate, admin: dict = Depends(require_admin)):
    new_id = str(uuid.uuid4())
    now = now_utc()
    scheda = SchedaTecnica().model_dump()
    await execute(
        """INSERT INTO work_orders (id, plate, vin, customer, vehicle, description, assigned_worker_ids, status, scheda_tecnica, approvata_il, approvata_da_nome, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)""",
        new_id, body.plate, body.vin, body.customer, body.vehicle, body.description,
        json.dumps(body.assigned_worker_ids), "open", json.dumps(scheda),
        now, admin["full_name"], now, now
    )
    return WorkOrder(
        id=new_id, plate=body.plate, vin=body.vin, customer=body.customer,
        vehicle=body.vehicle, description=body.description,
        assigned_worker_ids=body.assigned_worker_ids, status="open",
        scheda_tecnica=SchedaTecnica(**scheda), created_at=now, updated_at=now,
        approvata_il=now, approvata_da_nome=admin["full_name"],
    )


@api.post("/work-orders/{order_id}/approva", response_model=WorkOrder)
async def approva_commessa(order_id: str, admin: dict = Depends(require_admin)):
    """Il titolare approva. Il lavoro nel frattempo puo essere gia partito, anzi
    di solito lo e: l'approvazione dice 'ok, questo lavoro lo riconosco', non
    'adesso puoi cominciare'."""
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if row.get("approvata_il"):
        return _workorder_for_user(row_to_workorder(row), admin)
    await execute(
        "UPDATE work_orders SET approvata_il=$1, approvata_da_nome=$2, updated_at=$1 WHERE id=$3",
        now_utc(), admin["full_name"], order_id,
    )
    aggiornata = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    return _workorder_for_user(row_to_workorder(aggiornata), admin)


@api.post("/work-orders/{order_id}/fatturata", response_model=WorkOrder)
async def segna_fatturata(order_id: str, admin: dict = Depends(require_admin)):
    """Il titolare spunta la commessa: fattura preparata, esce dalla lista dei sospesi.
    Non tocca lo stato del lavoro, che resta completato: sono due cose diverse."""
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if row["status"] != "completed":
        raise HTTPException(status_code=400, detail="Si fattura solo un lavoro completato")
    if not row.get("fatturata_il"):
        await execute(
            "UPDATE work_orders SET fatturata_il=$1, fatturata_da_nome=$2, updated_at=$1 WHERE id=$3",
            now_utc(), admin["full_name"], order_id,
        )
    aggiornata = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    return _workorder_for_user(row_to_workorder(aggiornata), admin)


@api.post("/work-orders/{order_id}/annulla-fatturata", response_model=WorkOrder)
async def annulla_fatturata(order_id: str, admin: dict = Depends(require_admin)):
    """Rimette la commessa fra quelle da fatturare: capita di spuntare quella sbagliata."""
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    await execute(
        "UPDATE work_orders SET fatturata_il=NULL, fatturata_da_nome=NULL, updated_at=$1 WHERE id=$2",
        now_utc(), order_id,
    )
    aggiornata = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    return _workorder_for_user(row_to_workorder(aggiornata), admin)


async def commessa_aperta_stessa_targa(plate: str) -> Optional[dict]:
    """Una targa alla volta: se su quella targa c'è già una commessa non completata,
    la si restituisce. Due schede sulla stessa auto significano ore divise a metà,
    foto sparse e il titolare che non capisce quale sia quella buona."""
    return await fetchrow(
        """SELECT * FROM work_orders WHERE plate=$1 AND status <> 'completed'
           ORDER BY created_at DESC LIMIT 1""",
        plate,
    )


def _dettaglio_doppione(esistente: dict) -> dict:
    quando = esistente["created_at"].astimezone(FUSO_ITALIA).strftime("%d/%m alle %H:%M")
    chi = esistente["created_by_name"] or "Omnius (STAR)"
    return {
        "codice": "commessa_gia_aperta",
        "messaggio": (
            f"Su {esistente['plate']} c'è già una commessa aperta: "
            f"{esistente['description'] or 'senza descrizione'} — aperta da {chi} il {quando}. "
            "Lavora su quella invece di aprirne una seconda."
        ),
        "commessa_id": esistente["id"],
        "plate": esistente["plate"],
        "vehicle": esistente["vehicle"],
        "descrizione": esistente["description"],
        "aperta_da": chi,
        "aperta_il": quando,
        "stato": esistente["status"],
    }


@api.post("/work-orders/{order_id}/prendi", response_model=WorkOrder)
async def prendi_commessa(order_id: str, user: dict = Depends(get_current_user)):
    """Il meccanico si mette sulla commessa che esiste già (tipico dopo il blocco del
    doppione: le schede che arrivano da STAR non hanno nessuno assegnato)."""
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if row["status"] == "completed":
        raise HTTPException(status_code=409, detail="Commessa già completata")
    assegnati = list(row["assigned_worker_ids"] or [])
    if user["id"] not in assegnati:
        assegnati.append(user["id"])
        await execute(
            "UPDATE work_orders SET assigned_worker_ids=$1::jsonb, updated_at=$2 WHERE id=$3",
            json.dumps(assegnati), now_utc(), order_id,
        )
        row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    return _workorder_for_user(row_to_workorder(row), user)


@api.post("/work-orders/propose", response_model=WorkOrder)
async def propose_work_order(body: WorkOrderPropose, user: dict = Depends(get_current_user)):
    """Un operaio apre di sua iniziativa una scheda lavoro. Parte subito: il titolare
    la approva quando vuole, anche a lavoro finito."""
    new_id = str(uuid.uuid4())
    now = now_utc()
    scheda = SchedaTecnica().model_dump()
    assigned = [user["id"]]
    customer = (body.customer or "").strip() or "DA INSERIRE"
    vehicle = (body.vehicle or "").strip() or "Da identificare"
    plate = body.plate.strip().upper().replace(" ", "")
    esistente = await commessa_aperta_stessa_targa(plate)
    if esistente:
        raise HTTPException(status_code=409, detail=_dettaglio_doppione(esistente))
    await execute(
        """INSERT INTO work_orders
           (id, plate, vin, customer, vehicle, description, assigned_worker_ids, status, scheda_tecnica, created_by, created_by_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)""",
        new_id, plate, body.vin, customer, vehicle, body.description,
        json.dumps(assigned), "open", json.dumps(scheda), user["id"], user["full_name"], now, now
    )
    return WorkOrder(
        id=new_id, plate=plate, vin=body.vin, customer=customer,
        vehicle=vehicle, description=body.description,
        assigned_worker_ids=assigned, status="open",
        scheda_tecnica=SchedaTecnica(**scheda), created_by=user["id"], created_by_name=user["full_name"],
        created_at=now, updated_at=now
    )


# ---- Integrazione Omnius (STAR Magneti Marelli) ----
async def require_omnius_key(x_omnius_key: Optional[str] = Header(None)):
    if not OMNIUS_KEY:
        raise HTTPException(status_code=503, detail="Integrazione Omnius non configurata")
    if not x_omnius_key or x_omnius_key != OMNIUS_KEY:
        raise HTTPException(status_code=401, detail="Chiave Omnius non valida")
    return True


class OmniusRiga(BaseModel):
    codice: Optional[str] = None
    descrizione: str
    qta: Optional[float] = None
    tipo: Optional[str] = None       # "ricambio" | "manodopera"
    prezzo: Optional[float] = None   # sensibile: mostrato solo all'admin


class OmniusSchedaIn(BaseModel):
    star_doc_id: str
    plate: str
    vin: Optional[str] = None
    customer: Optional[str] = None
    vehicle: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None
    dtc_codes: List[str] = Field(default_factory=list)
    righe: Optional[List[OmniusRiga]] = None  # opzionale: se assente, fallback su note


def _riga_label(r: dict) -> str:
    """Etichetta checklist da una riga: 'Descrizione [codice] xqta'."""
    parts = [str(r.get("descrizione") or "").strip()]
    if r.get("codice"):
        parts.append(f"[{r['codice']}]")
    q = r.get("qta")
    if q not in (None, "", 1, 1.0):
        qn = int(q) if float(q).is_integer() else q
        parts.append(f"x{qn}")
    return " ".join(p for p in parts if p).strip()


class OmniusSchedaOut(BaseModel):
    # "adopted" = il documento STAR si è agganciato a una commessa già smistata dal planning
    action: Literal["created", "updated", "adopted"]
    work_order: WorkOrder


@api.post("/v1/omnius/commesse", response_model=OmniusSchedaOut, dependencies=[Depends(require_omnius_key)])
async def omnius_ingest_scheda(body: OmniusSchedaIn):
    """Riceve da Omnius una scheda STAR (diagnosi/accettazione/preventivo).
    Idempotente su star_doc_id: stesso id -> aggiorna la commessa esistente invece di duplicarla.
    Se la commessa non esiste, la crea in stato 'pending' (appare in 'DA APPROVARE' per il titolare)."""
    star_doc_id = body.star_doc_id.strip()
    if not star_doc_id:
        raise HTTPException(status_code=400, detail="star_doc_id obbligatorio")
    plate = body.plate.strip().upper().replace(" ", "")
    if not plate:
        raise HTTPException(status_code=400, detail="plate obbligatoria")

    # Righe strutturate (nuovo) o fallback sul testo note (vecchio).
    # In entrambi i casi le voci diventano checklist (lavori_da_fare).
    righe = [r.model_dump() for r in body.righe] if body.righe is not None else None
    if righe is not None:
        lavori_items = [_riga_label(r) for r in righe if (r.get("descrizione") or "").strip()]
    else:
        lavori_items = [s.strip() for s in (body.note or "").split(";") if s.strip()]
    extra_note = ("DTC: " + ", ".join(body.dtc_codes)) if body.dtc_codes else None

    existing = await fetchrow("SELECT * FROM work_orders WHERE star_doc_id=$1", star_doc_id)
    now = now_utc()

    # Se l'auto era già stata smistata dal planning dal titolare, il documento STAR si
    # AGGANCIA a quella commessa invece di crearne una seconda per la stessa macchina.
    # Così il lavoro che il meccanico ha già iniziato è anche quello che va in fattura.
    adottata = False
    if not existing:
        existing = await fetchrow(
            """SELECT * FROM work_orders
               WHERE plate=$1 AND planning_key IS NOT NULL AND star_doc_id IS NULL
                 AND status IN ('open', 'in_progress', 'paused')
               ORDER BY created_at DESC LIMIT 1""",
            plate,
        )
        adottata = existing is not None
        if adottata:
            logger.info(f"STAR {star_doc_id} agganciato alla commessa {existing['id']} nata dal planning ({plate})")

    if existing:
        scheda_raw = existing.get("scheda_tecnica") or {}
        if isinstance(scheda_raw, str):
            scheda_raw = json.loads(scheda_raw)
        merged_scheda = dict(scheda_raw)
        if righe is not None:
            # Sostituzione integrale delle righe (idempotenza), ma preserva le spunte del meccanico
            merged_scheda["righe"] = righe
            fatti = set(merged_scheda.get("lavori_fatti") or [])
            merged_scheda["lavori_da_fare"] = [it for it in lavori_items if it not in fatti]
        elif lavori_items:
            gia_noti = set((merged_scheda.get("lavori_da_fare") or []) + (merged_scheda.get("lavori_fatti") or []))
            merged_scheda["lavori_da_fare"] = (merged_scheda.get("lavori_da_fare") or []) + \
                [it for it in lavori_items if it not in gia_noti]
        if extra_note:
            prev = (merged_scheda.get("note") or "").strip()
            if extra_note not in prev:
                merged_scheda["note"] = f"{prev}\n{extra_note}".strip() if prev else extra_note

        parts = ["scheda_tecnica=$1::jsonb", "updated_at=$2"]
        vals: list = [json.dumps(merged_scheda), now]
        i = 3
        if body.description and body.description.strip():
            parts.append(f"description=${i}"); vals.append(body.description.strip()); i += 1
        if body.vin and body.vin.strip():
            parts.append(f"vin=${i}"); vals.append(body.vin.strip()); i += 1
        if adottata:
            # da qui in poi questa commessa è quella che Omnius ritira per la fattura
            parts.append(f"star_doc_id=${i}"); vals.append(star_doc_id); i += 1
        vals.append(existing["id"])
        row = await fetchrow(f"UPDATE work_orders SET {', '.join(parts)} WHERE id=${i} RETURNING *", *vals)
        return OmniusSchedaOut(action="adopted" if adottata else "updated", work_order=row_to_workorder(row))

    new_id = str(uuid.uuid4())
    scheda = SchedaTecnica(
        note=extra_note, lavori_da_fare=lavori_items, righe=(righe or []),
    ).model_dump()
    customer = (body.customer or "Cliente da definire").strip()
    vehicle = (body.vehicle or "Veicolo da definire").strip()
    description = (body.description or "Scheda ricevuta da Omnius/STAR").strip()
    await execute(
        """INSERT INTO work_orders
           (id, plate, vin, customer, vehicle, description, assigned_worker_ids, status, scheda_tecnica, created_by, created_by_name, star_doc_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14)""",
        new_id, plate, body.vin, customer, vehicle, description,
        json.dumps([]), "open", json.dumps(scheda), "omnius", "Omnius (STAR)", star_doc_id, now, now
    )
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", new_id)
    return OmniusSchedaOut(action="created", work_order=row_to_workorder(row))


# ---- Planning officina (snapshot da STAR via Omnius) ----
class PlanningIn(BaseModel):
    aggiornato: Optional[str] = None
    giorni_coperti: Optional[int] = None
    appuntamenti: List[dict] = Field(default_factory=list)


class PlanningOut(BaseModel):
    aggiornato: Optional[str] = None
    giorni_coperti: Optional[int] = None
    appuntamenti: List[dict]
    received_at: datetime


@api.post("/v1/omnius/planning", dependencies=[Depends(require_omnius_key)])
async def omnius_planning(body: PlanningIn):
    """Riceve lo snapshot completo del planning STAR (prossimi 7 giorni).
    Ogni invio SOSTITUISCE il precedente (niente merge)."""
    ora = now_utc()
    await execute(
        """INSERT INTO officina_planning (id, aggiornato, giorni_coperti, appuntamenti, received_at)
           VALUES (1, $1, $2, $3::jsonb, $4)
           ON CONFLICT (id) DO UPDATE SET aggiornato=$1, giorni_coperti=$2, appuntamenti=$3::jsonb, received_at=$4""",
        body.aggiornato, body.giorni_coperti, json.dumps(body.appuntamenti), ora
    )

    # Ogni giorno finisce anche nello storico, cosi il titolare puo tornare indietro:
    # sopra viene sovrascritto tutto a ogni invio, qui no.
    per_giorno: dict = {}
    for a in body.appuntamenti:
        g = (a or {}).get("giorno")
        if g:
            per_giorno.setdefault(g, []).append(a)
    for g, apps in per_giorno.items():
        try:
            # asyncpg vuole un oggetto date vero: il cast ::date nella query non basta,
            # perche' il parametro viene legato per tipo prima che il cast entri in gioco.
            giorno = date.fromisoformat(str(g)[:10])
            await execute(
                """INSERT INTO planning_storico (giorno, appuntamenti, aggiornato_il)
                   VALUES ($1, $2::jsonb, $3)
                   ON CONFLICT (giorno) DO UPDATE SET appuntamenti=$2::jsonb, aggiornato_il=$3""",
                giorno, json.dumps(apps), ora,
            )
        except Exception as e:
            logger.warning(f"storico planning {g}: {e}")

    return {"ok": True, "appuntamenti": len(body.appuntamenti), "giorni_archiviati": len(per_giorno)}


# ---------------- Cartellino presenze ----------------
FUSO_ITALIA = ZoneInfo("Europe/Rome")


def _giorno_italiano(dt: datetime) -> date:
    """Il server ragiona in UTC, l'officina vive in Italia: una timbratura delle
    00:30 italiane non deve finire nel giorno prima."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(FUSO_ITALIA).date()


def _distanza_m(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    """Distanza in metri tra due punti (formula dell'emisenoverso)."""
    r = 6371000.0
    f1, f2 = math.radians(lat1), math.radians(lat2)
    df, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(df / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(dl / 2) ** 2
    return int(round(2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))))


def _riga_timbratura(r: dict) -> Timbratura:
    return Timbratura(
        id=r["id"], worker_id=r["worker_id"], worker_name=r["worker_name"], tipo=r["tipo"],
        timestamp=r["timestamp"], giorno=r["giorno"].isoformat(),
        lat=r.get("lat"), lon=r.get("lon"), accuracy_m=r.get("accuracy_m"),
        distanza_m=r.get("distanza_m"), fuori_zona=r.get("fuori_zona") or False,
        posizione_assente=r.get("posizione_assente") or False,
        corretta_da_nome=r.get("corretta_da_nome"), motivo_correzione=r.get("motivo_correzione"),
    )


def _giornata(giorno: date, righe: List[dict], oggi: date) -> GiornataOut:
    """Somma i pezzi ENTRATA→USCITA. Se l'ultima timbratura è un'entrata:
    oggi si conta fino ad adesso, nei giorni passati la giornata è incompleta
    (si è dimenticato di timbrare l'uscita) e non entra nel saldo."""
    righe = sorted(righe, key=lambda r: r["timestamp"])
    minuti, aperta, incompleta = 0, None, False
    for r in righe:
        ts = r["timestamp"]
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if r["tipo"] == "ENTRATA":
            if aperta is None:
                aperta = ts
        else:
            if aperta is not None:
                minuti += max(0, int((ts - aperta).total_seconds() // 60))
                aperta = None
    dentro = aperta is not None
    if dentro:
        if giorno == oggi:
            minuti += max(0, int((now_utc() - aperta).total_seconds() // 60))
        else:
            incompleta = True
    target = _target_minuti(giorno)
    lorda = minuti - target
    # Tolleranza in ENTRAMBE le direzioni. Qualche minuto in piu' o in meno e' fisiologico:
    # ci si lava le mani, si finisce di parlare col cliente, si trova traffico. Senza margine
    # quei minuti diventano credito o debito che nessuno ha voluto — a Luciano si erano
    # accumulate 1h42m fatte di +9, +7, +1.
    # Oltre la soglia conta solo l'eccedenza: uscito alle 18:45 su un'uscita alle 18:30
    # maturano 5 minuti, non 15. Stesso trattamento per chi arriva tardi.
    if lorda > 0:
        netta = max(0, lorda - TOLLERANZA_MINUTI)
    else:
        netta = min(0, lorda + TOLLERANZA_MINUTI)
    return GiornataOut(
        giorno=giorno.isoformat(), minuti_presenza=minuti, minuti_target=target,
        differenza=netta, differenza_lorda=lorda,
        tolleranza_applicata=abs(lorda - netta),
        incompleta=incompleta,
        dentro_adesso=dentro and giorno == oggi,
        timbrature=[_riga_timbratura(r) for r in righe],
    )


async def _cartellino(worker_id: str, worker_name: str, da: Optional[date] = None) -> CartellinoOut:
    """Il cartellino di un meccanico. Il bersaglio delle 8h30 vale SOLO nei giorni
    in cui ha timbrato: chi non viene (sabato di riposo, ferie, malattia) non
    accumula debito — quella è assenza, non monte ore."""
    if da:
        righe = await fetch(
            "SELECT * FROM timbrature WHERE worker_id=$1 AND giorno>=$2 ORDER BY timestamp ASC",
            worker_id, da)
    else:
        righe = await fetch(
            "SELECT * FROM timbrature WHERE worker_id=$1 ORDER BY timestamp ASC", worker_id)

    per_giorno: dict = {}
    for r in righe:
        per_giorno.setdefault(r["giorno"], []).append(dict(r))

    oggi = _giorno_italiano(now_utc())
    giornate = [_giornata(g, rs, oggi) for g, rs in sorted(per_giorno.items(), reverse=True)]
    # La giornata IN CORSO non entra nel saldo: altrimenti alle 8:05 uno si vede
    # otto ore di debito solo perché la giornata è appena cominciata. Entra a fine
    # giornata, col segno giusto. Fuori anche i giorni senza uscita, da correggere.
    saldo = sum(g.differenza for g in giornate
                if not g.incompleta and g.giorno != oggi.isoformat())
    return CartellinoOut(
        worker_id=worker_id, worker_name=worker_name, giornate=giornate,
        saldo_minuti=saldo, giorni_incompleti=sum(1 for g in giornate if g.incompleta),
    )


async def _posizione_officina() -> Optional[dict]:
    row = await fetchrow("SELECT * FROM officina_posizione WHERE id=1")
    return dict(row) if row else None


@api.post("/timbrature", response_model=Timbratura)
async def timbra(body: TimbraturaIn, user: dict = Depends(get_current_user)):
    """Un tocco solo: se sei fuori entri, se sei dentro esci. La posizione viene
    sempre registrata e, se è lontana dall'officina, la timbratura resta valida
    ma segnalata — meglio saperlo che bloccare fuori chi ha il GPS ballerino."""
    if not user.get("cartellino_attivo", True):
        raise HTTPException(status_code=403, detail="Il cartellino non è attivo per questo utente")
    ultima = await fetchrow(
        "SELECT tipo FROM timbrature WHERE worker_id=$1 ORDER BY timestamp DESC LIMIT 1", user["id"])
    tipo = "USCITA" if (ultima and ultima["tipo"] == "ENTRATA") else "ENTRATA"

    lat, lon = body.lat, body.lon
    distanza = None
    fuori = False
    assente = lat is None or lon is None
    if not assente:
        centro = await _posizione_officina()
        if centro:
            distanza = _distanza_m(lat, lon, centro["lat"], centro["lon"])
            fuori = distanza > (centro.get("raggio_m") or RAGGIO_OFFICINA_M)

    ora = now_utc()
    tid = str(uuid.uuid4())
    await execute(
        """INSERT INTO timbrature (id, worker_id, worker_name, tipo, timestamp, giorno,
               lat, lon, accuracy_m, distanza_m, fuori_zona, posizione_assente, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)""",
        tid, user["id"], user["full_name"], tipo, ora, _giorno_italiano(ora),
        lat, lon, int(body.accuracy_m) if body.accuracy_m is not None else None,
        distanza, fuori, assente, ora,
    )
    if fuori or assente:
        logger.info(f"timbratura {tipo} di {user['full_name']}: "
                    f"{'posizione assente' if assente else f'{distanza} m dall officina'}")
    row = await fetchrow("SELECT * FROM timbrature WHERE id=$1", tid)
    return _riga_timbratura(dict(row))


@api.get("/timbrature/mio-cartellino", response_model=CartellinoOut)
async def mio_cartellino(giorni: int = 60, user: dict = Depends(get_current_user)):
    """Il meccanico vede le sue giornate e il suo saldo, senza chiedere a nessuno."""
    da = _giorno_italiano(now_utc()) - timedelta(days=max(1, min(giorni, 400)))
    return await _cartellino(user["id"], user["full_name"], da)


@api.get("/timbrature/cartellini", response_model=List[CartellinoOut])
async def cartellini(giorni: int = 30, admin: dict = Depends(require_admin)):
    """Tutti i cartellini per il titolare: chi è dentro adesso, le giornate, i saldi."""
    da = _giorno_italiano(now_utc()) - timedelta(days=max(1, min(giorni, 400)))
    operai = await fetch(
        "SELECT id, full_name FROM users WHERE role='worker' AND cartellino_attivo ORDER BY full_name")
    return [await _cartellino(w["id"], w["full_name"], da) for w in operai]


class TimbraturaCorreggiIn(BaseModel):
    timestamp: Optional[datetime] = None
    tipo: Optional[Literal["ENTRATA", "USCITA"]] = None
    motivo: str


@api.patch("/timbrature/{timbratura_id}", response_model=Timbratura)
async def correggi_timbratura(timbratura_id: str, body: TimbraturaCorreggiIn,
                              admin: dict = Depends(require_admin)):
    """Il titolare corregge una timbratura sbagliata. Il motivo è obbligatorio e
    resta scritto: chi ha corretto, quando e perché."""
    row = await fetchrow("SELECT * FROM timbrature WHERE id=$1", timbratura_id)
    if not row:
        raise HTTPException(status_code=404, detail="Timbratura non trovata")
    if not (body.motivo or "").strip():
        raise HTTPException(status_code=400, detail="Scrivi il motivo della correzione")
    ts = body.timestamp or row["timestamp"]
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    await execute(
        """UPDATE timbrature SET timestamp=$1, giorno=$2, tipo=$3,
               corretta_da=$4, corretta_da_nome=$5, corretta_il=$6, motivo_correzione=$7
           WHERE id=$8""",
        ts, _giorno_italiano(ts), body.tipo or row["tipo"],
        admin["id"], admin["full_name"], now_utc(), body.motivo.strip(), timbratura_id,
    )
    return _riga_timbratura(dict(await fetchrow("SELECT * FROM timbrature WHERE id=$1", timbratura_id)))


class TimbraturaManualeIn(BaseModel):
    worker_id: str
    tipo: Literal["ENTRATA", "USCITA"]
    timestamp: datetime
    motivo: str


@api.post("/timbrature/manuale", response_model=Timbratura)
async def timbratura_manuale(body: TimbraturaManualeIn, admin: dict = Depends(require_admin)):
    """Aggiunge una timbratura mancante (il classico: si è dimenticato di uscire)."""
    if not (body.motivo or "").strip():
        raise HTTPException(status_code=400, detail="Scrivi il motivo")
    w = await fetchrow("SELECT id, full_name FROM users WHERE id=$1", body.worker_id)
    if not w:
        raise HTTPException(status_code=404, detail="Meccanico non trovato")
    ts = body.timestamp if body.timestamp.tzinfo else body.timestamp.replace(tzinfo=timezone.utc)
    tid = str(uuid.uuid4())
    await execute(
        """INSERT INTO timbrature (id, worker_id, worker_name, tipo, timestamp, giorno,
               posizione_assente, corretta_da, corretta_da_nome, corretta_il, motivo_correzione, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9,$10,$11)""",
        tid, w["id"], w["full_name"], body.tipo, ts, _giorno_italiano(ts),
        admin["id"], admin["full_name"], now_utc(), body.motivo.strip(), now_utc(),
    )
    return _riga_timbratura(dict(await fetchrow("SELECT * FROM timbrature WHERE id=$1", tid)))


class GiornataStandardIn(BaseModel):
    worker_id: str
    giorno: str          # AAAA-MM-GG
    motivo: str


# Le fasce concordate, per ricostruire una giornata intera in un colpo solo.
ORARIO_STANDARD = {
    "feriale": [("ENTRATA", 8, 30), ("USCITA", 13, 0), ("ENTRATA", 14, 30), ("USCITA", 18, 30)],
    "sabato": [("ENTRATA", 8, 0), ("USCITA", 13, 30)],
}


@api.post("/timbrature/giornata-standard", response_model=List[Timbratura])
async def timbratura_giornata_standard(body: GiornataStandardIn, admin: dict = Depends(require_admin)):
    """Il caso vero: l'operaio ha lavorato tutto il giorno ma non è riuscito a
    entrare nell'app e non ha timbrato niente. Il titolare gli mette la giornata
    intera con un tocco, sulle fasce concordate."""
    if not (body.motivo or "").strip():
        raise HTTPException(status_code=400, detail="Scrivi il motivo")
    w = await fetchrow("SELECT id, full_name FROM users WHERE id=$1", body.worker_id)
    if not w:
        raise HTTPException(status_code=404, detail="Meccanico non trovato")
    try:
        giorno = date.fromisoformat(body.giorno)
    except ValueError:
        raise HTTPException(status_code=400, detail="Data non valida")
    if giorno.weekday() == 6:
        raise HTTPException(status_code=400, detail="La domenica non ha un orario standard: aggiungi le timbrature a mano")

    gia = await fetchrow(
        "SELECT id FROM timbrature WHERE worker_id=$1 AND giorno=$2 LIMIT 1", body.worker_id, giorno)
    if gia:
        raise HTTPException(
            status_code=409,
            detail="Quel giorno ha già delle timbrature: correggile invece di sovrascrivere la giornata")

    fasce = ORARIO_STANDARD["sabato" if giorno.weekday() == 5 else "feriale"]
    creati: List[Timbratura] = []
    ora = now_utc()
    for tipo, hh, mm in fasce:
        ts = datetime(giorno.year, giorno.month, giorno.day, hh, mm, tzinfo=FUSO_ITALIA).astimezone(timezone.utc)
        tid = str(uuid.uuid4())
        await execute(
            """INSERT INTO timbrature (id, worker_id, worker_name, tipo, timestamp, giorno,
                   posizione_assente, corretta_da, corretta_da_nome, corretta_il, motivo_correzione, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9,$10,$11)""",
            tid, w["id"], w["full_name"], tipo, ts, giorno,
            admin["id"], admin["full_name"], ora, body.motivo.strip(), ora,
        )
        creati.append(_riga_timbratura(dict(await fetchrow("SELECT * FROM timbrature WHERE id=$1", tid))))
    return creati


class GiornataRiscriviIn(BaseModel):
    worker_id: str
    giorno: str                            # AAAA-MM-GG
    entrata: str                           # HH:MM
    uscita: str                            # HH:MM
    pausa_inizio: Optional[str] = None     # HH:MM, opzionale
    pausa_fine: Optional[str] = None
    motivo: str


def _ora_hhmm(valore: str, campo: str) -> tuple:
    """'08:30' -> (8, 30). Accetta anche 8.30 e 8,30: al titolare non si chiede
    di ricordarsi quale separatore vuole la macchina."""
    testo = (valore or "").strip().replace(".", ":").replace(",", ":")
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", testo)
    if not m:
        raise HTTPException(status_code=400, detail=f"{campo}: scrivi l'ora come 08:30")
    hh, mm = int(m.group(1)), int(m.group(2))
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise HTTPException(status_code=400, detail=f"{campo}: ora inesistente")
    return hh, mm


@api.post("/timbrature/giornata", response_model=List[Timbratura])
async def timbratura_giornata_riscrivi(body: GiornataRiscriviIn, admin: dict = Depends(require_admin)):
    """Riscrive l'INTERA giornata di un meccanico: entrata, uscita ed eventuale pausa.

    Serve quando la giornata e' da rifare da capo — timbrature doppie, orari sbagliati,
    tocchi ripetuti — e correggerle una per una sarebbe piu' lento che riscriverle.
    Cancella quelle esistenti di quel giorno e mette quelle nuove."""
    if not (body.motivo or "").strip():
        raise HTTPException(status_code=400, detail="Scrivi il motivo")
    w = await fetchrow("SELECT id, full_name FROM users WHERE id=$1", body.worker_id)
    if not w:
        raise HTTPException(status_code=404, detail="Meccanico non trovato")
    try:
        giorno = date.fromisoformat(body.giorno)
    except ValueError:
        raise HTTPException(status_code=400, detail="Data non valida")

    e_h, e_m = _ora_hhmm(body.entrata, "Entrata")
    u_h, u_m = _ora_hhmm(body.uscita, "Uscita")

    fasce = [("ENTRATA", e_h, e_m)]
    if body.pausa_inizio or body.pausa_fine:
        if not (body.pausa_inizio and body.pausa_fine):
            raise HTTPException(status_code=400, detail="Della pausa servono sia inizio sia fine")
        pi_h, pi_m = _ora_hhmm(body.pausa_inizio, "Inizio pausa")
        pf_h, pf_m = _ora_hhmm(body.pausa_fine, "Fine pausa")
        fasce += [("USCITA", pi_h, pi_m), ("ENTRATA", pf_h, pf_m)]
    fasce.append(("USCITA", u_h, u_m))

    # gli orari devono susseguirsi: entrata < pausa < rientro < uscita
    minuti = [h * 60 + m for _, h, m in fasce]
    if any(minuti[i] >= minuti[i + 1] for i in range(len(minuti) - 1)):
        raise HTTPException(
            status_code=400,
            detail="Gli orari devono essere in ordine: entrata, inizio pausa, fine pausa, uscita")

    ora = now_utc()
    motivo = body.motivo.strip()
    quante_prima = await fetchrow(
        "SELECT count(*) AS n FROM timbrature WHERE worker_id=$1 AND giorno=$2", body.worker_id, giorno)
    await execute("DELETE FROM timbrature WHERE worker_id=$1 AND giorno=$2", body.worker_id, giorno)

    creati: List[Timbratura] = []
    for tipo, hh, mm in fasce:
        ts = datetime(giorno.year, giorno.month, giorno.day, hh, mm, tzinfo=FUSO_ITALIA).astimezone(timezone.utc)
        tid = str(uuid.uuid4())
        await execute(
            """INSERT INTO timbrature (id, worker_id, worker_name, tipo, timestamp, giorno,
                   posizione_assente, corretta_da, corretta_da_nome, corretta_il, motivo_correzione, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9,$10,$11)""",
            tid, w["id"], w["full_name"], tipo, ts, giorno,
            admin["id"], admin["full_name"], ora, motivo, ora,
        )
        creati.append(_riga_timbratura(dict(await fetchrow("SELECT * FROM timbrature WHERE id=$1", tid))))

    logger.info(f"giornata riscritta: {w['full_name']} {giorno} da {admin['full_name']} "
                f"({quante_prima['n']} timbrature sostituite) — {motivo}")
    return creati


@api.delete("/timbrature/{timbratura_id}")
async def elimina_timbratura(timbratura_id: str, admin: dict = Depends(require_admin)):
    """Toglie una timbratura doppia (due tocchi per sbaglio)."""
    row = await fetchrow("SELECT id FROM timbrature WHERE id=$1", timbratura_id)
    if not row:
        raise HTTPException(status_code=404, detail="Timbratura non trovata")
    await execute("DELETE FROM timbrature WHERE id=$1", timbratura_id)
    return {"ok": True}


class PosizioneOfficinaIn(BaseModel):
    lat: float
    lon: float
    raggio_m: int = RAGGIO_OFFICINA_M


class PosizioneOfficinaOut(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    raggio_m: int = RAGGIO_OFFICINA_M
    impostata_da_nome: Optional[str] = None
    impostata_il: Optional[datetime] = None
    configurata: bool = False


@api.get("/officina/posizione", response_model=PosizioneOfficinaOut)
async def leggi_posizione_officina(user: dict = Depends(get_current_user)):
    centro = await _posizione_officina()
    if not centro:
        return PosizioneOfficinaOut(configurata=False)
    return PosizioneOfficinaOut(
        lat=centro["lat"], lon=centro["lon"], raggio_m=centro["raggio_m"],
        impostata_da_nome=centro.get("impostata_da_nome"), impostata_il=centro.get("impostata_il"),
        configurata=True,
    )


@api.post("/officina/posizione", response_model=PosizioneOfficinaOut)
async def imposta_posizione_officina(body: PosizioneOfficinaIn, admin: dict = Depends(require_admin)):
    """Il titolare, STANDO IN OFFICINA, fissa qui il centro: da lì si misurano i metri."""
    ora = now_utc()
    await execute(
        """INSERT INTO officina_posizione (id, lat, lon, raggio_m, impostata_da_nome, impostata_il)
           VALUES (1,$1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET lat=$1, lon=$2, raggio_m=$3, impostata_da_nome=$4, impostata_il=$5""",
        body.lat, body.lon, max(50, min(body.raggio_m, 20000)), admin["full_name"], ora,
    )
    return await leggi_posizione_officina(admin)


def _planning_key(giorno: Optional[str], ora: Optional[str], targa: Optional[str]) -> str:
    """Identifica un appuntamento del planning. Gli appuntamenti di STAR non hanno un id
    e lo snapshot viene riscritto ogni volta: giorno+ora+targa è la cosa più stabile che c'è."""
    g = (giorno or "").strip()
    o = (ora or "").strip()
    t = (targa or "").strip().upper().replace(" ", "")
    return f"{g}|{o}|{t}"


class PlanningCreaIn(BaseModel):
    giorno: Optional[str] = None
    ora: Optional[str] = None
    ora_fine: Optional[str] = None
    ponte: Optional[str] = None
    targa: str
    cliente: Optional[str] = None
    veicolo: Optional[str] = None
    nota: Optional[str] = None
    assigned_worker_ids: List[str] = Field(default_factory=list)


class PlanningCreaOut(BaseModel):
    work_order: WorkOrder
    gia_esistente: bool  # True se l'appuntamento era già stato smistato


class PlanningGiornoOut(BaseModel):
    giorno: str
    appuntamenti: int
    passato: bool
    oggi: bool = False


@api.get("/planning/giorni", response_model=List[PlanningGiornoOut])
async def planning_giorni(indietro: int = 15, avanti: int = 14,
                          admin: dict = Depends(require_admin)):
    """I giorni che il titolare puo aprire nel planning.

    Li genera TUTTI nell'intervallo, non solo quelli che hanno appuntamenti: in officina
    si lavora anche in giorni che STAR non ha mandato — il sabato, o le auto arrivate
    senza appuntamento — e quei giorni devono restare apribili lo stesso.
    Fuori solo le domeniche vuote, che sarebbero rumore."""
    oggi = _giorno_italiano(now_utc())
    da = oggi - timedelta(days=max(1, min(indietro, 365)))
    a = oggi + timedelta(days=max(1, min(avanti, 365)))
    righe = await fetch(
        """SELECT d::date AS giorno,
                  COALESCE(jsonb_array_length(ps.appuntamenti), 0) AS quanti
           FROM generate_series($1::date, $2::date, '1 day') d
           LEFT JOIN planning_storico ps ON ps.giorno = d::date
           WHERE EXTRACT(dow FROM d) <> 0
              OR COALESCE(jsonb_array_length(ps.appuntamenti), 0) > 0
           ORDER BY d DESC""",
        da, a,
    )
    return [
        PlanningGiornoOut(giorno=r["giorno"].isoformat(), appuntamenti=r["quanti"] or 0,
                          passato=r["giorno"] < oggi, oggi=r["giorno"] == oggi)
        for r in righe
    ]


async def _arricchisci_appuntamenti(apps: list) -> list:
    """Aggiunge a ogni appuntamento se e gia diventato commessa e a chi e assegnata."""
    smistate = await fetch(
        "SELECT id, planning_key, status, assigned_worker_ids FROM work_orders WHERE planning_key IS NOT NULL"
    )
    nomi = {u["id"]: u["full_name"] for u in await fetch("SELECT id, full_name FROM users")}
    per_chiave: dict = {}
    for w in smistate:
        ids = w.get("assigned_worker_ids") or []
        if isinstance(ids, str):
            ids = json.loads(ids)
        per_chiave[w["planning_key"]] = {
            "commessa_id": w["id"],
            "commessa_status": w["status"],
            "assegnata_a": [nomi.get(i) for i in ids if nomi.get(i)],
        }

    arricchiti = []
    for a in apps:
        a = dict(a)
        trovata = per_chiave.get(_planning_key(a.get("giorno"), a.get("ora"), a.get("targa")))
        a.update(trovata or {"commessa_id": None, "commessa_status": None, "assegnata_a": []})
        arricchiti.append(a)
    return arricchiti


@api.get("/planning", response_model=PlanningOut)
async def get_planning(giorno: Optional[str] = None, admin: dict = Depends(require_admin)):
    """Il planning STAR per la pagina admin. Ogni appuntamento porta con sé se è già
    diventato una commessa (commessa_id + a chi è assegnata), così il titolare vede
    a colpo d'occhio cosa ha già smistato.

    Senza `giorno` restituisce l'ultimo invio di Omnius (i prossimi giorni).
    Con `giorno` pesca dallo storico, cosi si possono rivedere anche i giorni passati."""
    if giorno:
        try:
            g = date.fromisoformat(giorno)
        except ValueError:
            raise HTTPException(status_code=400, detail="Data non valida")
        riga = await fetchrow("SELECT * FROM planning_storico WHERE giorno=$1", g)
        # Un giorno senza appuntamenti non e un errore: in officina si lavora anche
        # su auto arrivate senza appuntamento, e il giorno va comunque apribile.
        apps = []
        if riga:
            apps = riga["appuntamenti"] or []
            if isinstance(apps, str):
                apps = json.loads(apps)
        return PlanningOut(
            aggiornato=giorno, giorni_coperti=1,
            appuntamenti=await _arricchisci_appuntamenti(apps),
            received_at=riga["aggiornato_il"] if riga else now_utc(),
        )

    row = await fetchrow("SELECT * FROM officina_planning WHERE id=1")
    if not row:
        raise HTTPException(status_code=404, detail="Planning non ancora ricevuto da Omnius")
    apps = row.get("appuntamenti") or []
    if isinstance(apps, str):
        apps = json.loads(apps)

    return PlanningOut(
        aggiornato=row.get("aggiornato"), giorni_coperti=row.get("giorni_coperti"),
        appuntamenti=await _arricchisci_appuntamenti(apps), received_at=row["received_at"],
    )


@api.post("/planning/crea-commessa", response_model=PlanningCreaOut)
async def planning_crea_commessa(body: PlanningCreaIn, admin: dict = Depends(require_admin)):
    """Il titolare tocca un'auto del planning e la assegna a uno o più meccanici:
    nasce la commessa, con targa, cliente, veicolo e lavoro già dentro."""
    targa = (body.targa or "").strip().upper().replace(" ", "")
    if not targa:
        raise HTTPException(status_code=400, detail="Targa mancante nell'appuntamento")
    chiave = _planning_key(body.giorno, body.ora, targa)

    # già smistato? restituiamo quella commessa invece di crearne un'altra
    esistente = await fetchrow("SELECT * FROM work_orders WHERE planning_key=$1", chiave)
    if esistente:
        wo = row_to_workorder(esistente)
        return PlanningCreaOut(work_order=_workorder_for_user(wo, admin), gia_esistente=True)

    validi = {u["id"] for u in await fetch("SELECT id FROM users WHERE role='worker'")}
    operai = [w for w in body.assigned_worker_ids if w in validi]
    if not operai:
        raise HTTPException(status_code=400, detail="Scegli almeno un meccanico a cui assegnare il lavoro")

    # l'appuntamento (giorno, orario, ponte) resta scritto nella scheda
    appunto = " · ".join(filter(None, [
        f"Appuntamento {body.giorno}" if body.giorno else None,
        f"{body.ora}–{body.ora_fine}" if body.ora and body.ora_fine else (body.ora or None),
        body.ponte or None,
    ]))
    scheda = SchedaTecnica(note=f"Dal planning STAR — {appunto}" if appunto else "Dal planning STAR").model_dump()

    new_id = str(uuid.uuid4())
    now = now_utc()
    await execute(
        """INSERT INTO work_orders (id, plate, customer, vehicle, description, assigned_worker_ids,
               status, scheda_tecnica, created_by, created_by_name, planning_key,
               approvata_il, approvata_da_nome, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)""",
        new_id, targa,
        (body.cliente or "").strip() or "DA INSERIRE",
        (body.veicolo or "").strip() or "Da identificare",
        (body.nota or "").strip() or "Dal planning: lavoro da concordare",
        json.dumps(operai), "open", json.dumps(scheda),
        admin["id"], admin["full_name"], chiave, now, admin["full_name"], now, now,
    )

    # i dati veicolo li chiediamo a STAR come per le altre commesse
    if OMNIUS_KEY:
        try:
            await execute(
                """INSERT INTO plate_lookup_requests (id, work_order_id, plate, status, requested_by_name, created_at)
                   VALUES ($1,$2,$3,'pending',$4,$5)""",
                str(uuid.uuid4()), new_id, targa, admin["full_name"], now
            )
        except Exception as e:
            logger.warning(f"planning: richiesta dati veicolo non messa in coda ({e})")

    # il meccanico va avvisato: prima assegnare una commessa non notificava nessuno
    asyncio.create_task(_push_to_users(
        operai, "Nuovo lavoro assegnato",
        f"[{targa}] {(body.nota or '').strip()[:80] or 'dal planning'}",
        url=f"/(worker)/order/{new_id}",
    ))

    creata = await fetchrow("SELECT * FROM work_orders WHERE id=$1", new_id)
    return PlanningCreaOut(work_order=_workorder_for_user(row_to_workorder(creata), admin), gia_esistente=False)


# ---- Sportello di lettura report per Omnius (Fase 2) ----
class OmniusEventOut(BaseModel):
    type: EventType
    timestamp: datetime
    worker_full_name: str
    reason: Optional[str] = None
    ai_interpretation: Optional[str] = None


class OmniusPhotoOut(BaseModel):
    id: str
    uploaded_by_name: str
    created_at: datetime
    url: str


class OmniusReportItem(BaseModel):
    star_doc_id: str
    work_order_id: str
    plate: str
    vehicle: str
    customer: str
    status: OrderStatus
    updated_at: datetime
    workers: List[str]
    minutes_worked: int                            # ore dai timbri (registro grezzo)
    minutes_effective: int                         # ore da fatturare (corrette dal meccanico, o = calcolate)
    minutes_effective_reason: Optional[str] = None
    events: List[OmniusEventOut]
    scheda_tecnica: SchedaTecnica                  # include ricambi_sostituiti (pezzi veri) per la fattura
    dialogo: List[dict]
    photos: List[OmniusPhotoOut]


class OmniusReportsOut(BaseModel):
    items: List[OmniusReportItem]
    count: int
    has_more: bool
    next_updated_since: Optional[datetime] = None


class OmniusPreventivoRiga(BaseModel):
    tipo: str                                  # "ricambio" | "manodopera" | "consumabile"
    codice: Optional[str] = None
    descrizione: Optional[str] = None
    quantita: float = 1
    prezzo_unitario: float = 0                 # quello da mettere sul preventivo cliente
    importo: float = 0
    costo_unitario: Optional[float] = None     # quanto e' costato all'officina
    fornitore: Optional[str] = None


class OmniusPreventivoOut(BaseModel):
    work_order_id: str
    star_doc_id: Optional[str] = None          # a quale documento STAR agganciarlo
    plate: str
    customer: Optional[str] = None
    vehicle: Optional[str] = None
    lavoro: Optional[str] = None
    completata_il: Optional[datetime] = None
    righe: List[OmniusPreventivoRiga]
    imponibile: float
    iva_perc: float
    iva: float
    totale: float
    dati_mancanti: List[str] = Field(default_factory=list)


@api.get("/v1/omnius/preventivi", response_model=List[OmniusPreventivoOut],
         dependencies=[Depends(require_omnius_key)])
async def omnius_preventivi(solo_nuovi: bool = True, limit: int = 20):
    """Sportello di ritiro dei preventivi per Omnius.

    Restituisce i lavori COMPLETATI con le righe gia' pronte da caricare sul preventivo
    STAR: ricambi coi prezzi di vendita, manodopera e consumabili. Il postino li ritira,
    li carica su STAR e poi conferma su /preventivi/{id}/caricato, cosi' non li riprende
    al giro dopo — stesso schema delle richieste targa.

    solo_nuovi=false li restituisce tutti, anche quelli gia' consegnati (per rifare)."""
    conds = ["status = 'completed'"]
    if solo_nuovi:
        conds.append("preventivo_inviato_il IS NULL")
    rows = await fetch(
        f"""SELECT id, plate, customer, vehicle, description, star_doc_id, updated_at
              FROM work_orders WHERE {' AND '.join(conds)}
             ORDER BY updated_at DESC LIMIT $1""",
        max(1, min(limit, 100)),
    )

    fuori: List[OmniusPreventivoOut] = []
    for w in rows:
        p = await calcola_preventivo(w["id"])
        # senza ricambi e senza ore non c'e' niente da caricare: si salta invece di
        # consegnare un preventivo vuoto che poi qualcuno dovrebbe ricompilare a mano
        if not p.get("ricambi") and not p.get("ore"):
            continue

        righe: List[OmniusPreventivoRiga] = []
        for r in p.get("ricambi") or []:
            righe.append(OmniusPreventivoRiga(
                tipo="ricambio", codice=r.get("codice"), descrizione=r.get("descrizione"),
                quantita=r.get("quantita") or 1, prezzo_unitario=r.get("prezzo") or 0,
                importo=r.get("totale") or 0, costo_unitario=r.get("costo"),
                fornitore=r.get("fornitore"),
            ))
        for c in p.get("consumabili") or []:
            unita = f" ({c['unita']})" if c.get("unita") else ""
            righe.append(OmniusPreventivoRiga(
                tipo="consumabile", descrizione=f"{c['nome']}{unita}",
                quantita=c.get("quantita") or 1, prezzo_unitario=c.get("prezzo") or 0,
                importo=c.get("totale") or 0,
            ))
        if p.get("ore"):
            righe.append(OmniusPreventivoRiga(
                tipo="manodopera", descrizione="Manodopera",
                quantita=p["ore"], prezzo_unitario=p["tariffa_oraria"],
                importo=p["manodopera"],
            ))

        fuori.append(OmniusPreventivoOut(
            work_order_id=w["id"], star_doc_id=w["star_doc_id"], plate=w["plate"],
            customer=w["customer"], vehicle=w["vehicle"], lavoro=w["description"],
            completata_il=w["updated_at"], righe=righe,
            imponibile=p["imponibile"], iva_perc=p["iva_perc"], iva=p["iva"],
            totale=p["totale"], dati_mancanti=p.get("mancanze") or [],
        ))
    return fuori


class OmniusCaricatoIn(BaseModel):
    preventivo_star_id: Optional[str] = None   # il numero che STAR ha dato al preventivo


@api.post("/v1/omnius/preventivi/{order_id}/caricato", dependencies=[Depends(require_omnius_key)])
async def omnius_preventivo_caricato(order_id: str, body: OmniusCaricatoIn = OmniusCaricatoIn()):
    """Il postino conferma di aver caricato il preventivo su STAR: da qui in poi non
    glielo ridiamo piu'. Se STAR restituisce un numero, lo teniamo per il riscontro."""
    row = await fetchrow("SELECT id FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    await execute(
        "UPDATE work_orders SET preventivo_inviato_il=$1, preventivo_star_id=$2 WHERE id=$3",
        now_utc(), body.preventivo_star_id, order_id,
    )
    logger.info(f"preventivo {order_id} caricato su STAR ({body.preventivo_star_id or 'senza numero'})")
    return {"ok": True}


@api.get("/v1/omnius/commesse", response_model=OmniusReportsOut, dependencies=[Depends(require_omnius_key)])
async def omnius_read_reports(updated_since: Optional[str] = None, status: Optional[str] = None, limit: int = 100):
    """Sportello di ritiro report per Omnius. Restituisce le commesse agganciate a STAR
    (star_doc_id valorizzato) aggiornate dopo 'updated_since', con eventi, tempi, scheda,
    dialogo e foto. Paginazione tramite next_updated_since (stile polling idempotente)."""
    limit = max(1, min(limit, 100))
    since = _parse_iso_dt(updated_since) if updated_since else datetime(1970, 1, 1, tzinfo=timezone.utc)

    conds = ["star_doc_id IS NOT NULL", "updated_at > $1"]
    vals: list = [since]
    if status:
        conds.append(f"status = ${len(vals) + 1}")
        vals.append(status)
    vals.append(limit + 1)  # +1 per capire se c'è altro
    rows = await fetch(
        f"SELECT * FROM work_orders WHERE {' AND '.join(conds)} ORDER BY updated_at ASC, id ASC LIMIT ${len(vals)}",
        *vals
    )
    has_more = len(rows) > limit
    rows = rows[:limit]

    # Nomi operai
    user_rows = await fetch("SELECT id, full_name FROM users")
    uname = {u["id"]: u["full_name"] for u in user_rows}

    items: List[OmniusReportItem] = []
    for row in rows:
        oid = row["id"]
        evs = await fetch(
            "SELECT * FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC", oid
        )
        events = [OmniusEventOut(
            type=e["type"], timestamp=e["timestamp"], worker_full_name=e["worker_full_name"],
            reason=e.get("reason"), ai_interpretation=e.get("ai_interpretation"),
        ) for e in evs]
        worker_ids = row.get("assigned_worker_ids") or []
        if isinstance(worker_ids, str):
            worker_ids = json.loads(worker_ids)
        workers = sorted({uname.get(w) for w in worker_ids if uname.get(w)} |
                         {e["worker_full_name"] for e in evs})
        scheda_raw = row.get("scheda_tecnica") or {}
        if isinstance(scheda_raw, str):
            scheda_raw = json.loads(scheda_raw)
        convo = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", oid)
        turns = convo["turns"] if convo else []
        if isinstance(turns, str):
            turns = json.loads(turns)
        photo_rows = await fetch(
            "SELECT id, uploaded_by_name, created_at FROM order_photos WHERE work_order_id=$1 ORDER BY created_at ASC", oid
        )
        photos = [OmniusPhotoOut(
            id=p["id"], uploaded_by_name=p["uploaded_by_name"], created_at=p["created_at"],
            url=f"{PUBLIC_BASE_URL}/api/photos/{p['id']}/file?omnius_key={OMNIUS_KEY}",
        ) for p in photo_rows]
        items.append(OmniusReportItem(
            star_doc_id=row["star_doc_id"], work_order_id=oid, plate=row["plate"],
            vehicle=row["vehicle"], customer=row["customer"], status=row["status"],
            updated_at=row["updated_at"], workers=list(workers), minutes_worked=_worker_minutes(evs),
            minutes_effective=(row.get("minutes_effective") if row.get("minutes_effective") is not None else _worker_minutes(evs)),
            minutes_effective_reason=row.get("minutes_effective_reason"),
            events=events, scheda_tecnica=SchedaTecnica(**scheda_raw),
            dialogo=turns or [], photos=photos,
        ))

    return OmniusReportsOut(
        items=items, count=len(items), has_more=has_more,
        next_updated_since=(items[-1].updated_at if items else since),
    )


@api.get("/work-orders/{order_id}", response_model=WorkOrder)
async def get_work_order(order_id: str, user: dict = Depends(get_current_user)):
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    if user["role"] == "worker" and user["id"] not in worker_ids:
        raise HTTPException(status_code=403, detail="Non assegnato")
    wo = row_to_workorder(row)
    evs = await fetch("SELECT type, timestamp FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC", order_id)
    wo.minutes_calculated = _worker_minutes(evs)
    return _workorder_for_user(wo, user)


class ToggleLavoroIn(BaseModel):
    item: str
    done: bool


@api.post("/work-orders/{order_id}/scheda/toggle-lavoro", response_model=SchedaTecnica)
async def toggle_lavoro(order_id: str, body: ToggleLavoroIn, user: dict = Depends(get_current_user)):
    """Spunta (o togli la spunta a) un lavoro: sposta la voce tra 'da fare' e 'fatti'."""
    row = await _order_or_403(order_id, user)
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    item = body.item.strip()
    if not item:
        raise HTTPException(status_code=400, detail="Voce vuota")
    da_fare = [x for x in (scheda_raw.get("lavori_da_fare") or [])]
    fatti = [x for x in (scheda_raw.get("lavori_fatti") or [])]
    if body.done:
        da_fare = [x for x in da_fare if x != item]
        if item not in fatti:
            fatti.append(item)
    else:
        fatti = [x for x in fatti if x != item]
        if item not in da_fare:
            da_fare.append(item)
    scheda_raw["lavori_da_fare"] = da_fare
    scheda_raw["lavori_fatti"] = fatti
    scheda = SchedaTecnica(**scheda_raw)
    await execute(
        "UPDATE work_orders SET scheda_tecnica=$1::jsonb, updated_at=$2 WHERE id=$3",
        json.dumps(scheda.model_dump()), now_utc(), order_id
    )
    return _scheda_for_user(scheda, user)


@api.post("/work-orders/{order_id}/scheda/toggle-ricambio", response_model=SchedaTecnica)
async def toggle_ricambio(order_id: str, body: ToggleLavoroIn, user: dict = Depends(get_current_user)):
    """Spunta un ricambio come VERAMENTE sostituito (o togli la spunta): sposta la voce
    tra 'necessari' (previsti) e 'sostituiti' (montati davvero). I sostituiti vanno in fattura."""
    row = await _order_or_403(order_id, user)
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    item = body.item.strip()
    if not item:
        raise HTTPException(status_code=400, detail="Voce vuota")
    necessari = [x for x in (scheda_raw.get("ricambi_necessari") or [])]
    sostituiti = [x for x in (scheda_raw.get("ricambi_sostituiti") or [])]
    if body.done:
        necessari = [x for x in necessari if x != item]
        if item not in sostituiti:
            sostituiti.append(item)
    else:
        sostituiti = [x for x in sostituiti if x != item]
        if item not in necessari:
            necessari.append(item)
    scheda_raw["ricambi_necessari"] = necessari
    scheda_raw["ricambi_sostituiti"] = sostituiti
    scheda = SchedaTecnica(**scheda_raw)
    await execute(
        "UPDATE work_orders SET scheda_tecnica=$1::jsonb, updated_at=$2 WHERE id=$3",
        json.dumps(scheda.model_dump()), now_utc(), order_id
    )
    if row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(order_id))
    return _scheda_for_user(scheda, user)


class EffectiveHoursIn(BaseModel):
    minutes: Optional[int] = None   # None = azzera la correzione, tornano valide le calcolate
    reason: Optional[str] = None


@api.post("/work-orders/{order_id}/effective-hours", response_model=WorkOrder)
async def set_effective_hours(order_id: str, body: EffectiveHoursIn, user: dict = Depends(get_current_user)):
    """Il meccanico corregge il totale ORE EFFETTIVE (quelle che vanno in fattura), se i
    timbri non tornano (es. pausa dimenticata). Le ore calcolate dai timbri restano intatte."""
    row = await _order_or_403(order_id, user)
    mins = body.minutes
    if mins is not None and not (0 <= mins <= 100000):
        raise HTTPException(status_code=400, detail="Ore non valide")
    reason = (body.reason or "").strip() or None
    await execute(
        "UPDATE work_orders SET minutes_effective=$1, minutes_effective_reason=$2, updated_at=$3 WHERE id=$4",
        mins, reason, now_utc(), order_id
    )
    if row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(order_id))
    updated = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    wo = row_to_workorder(updated)
    evs = await fetch("SELECT type, timestamp FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC", order_id)
    wo.minutes_calculated = _worker_minutes(evs)
    return _workorder_for_user(wo, user)


class OreProposteOut(BaseModel):
    minuti_proposti: int              # quanto proponiamo di mettere in fattura
    minuti_timbri: int                # quanto dicono i timbri (registro grezzo)
    # "note"    = lette da ciò che ha scritto il meccanico
    # "timbri"  = nelle note non c'era nessun tempo, ripieghiamo sui timbri
    # "errore"  = l'AI non ha risposto: NON dire al meccanico che non ha scritto le ore
    fonte: Literal["note", "timbri", "errore"]
    citazione: Optional[str] = None   # le parole del meccanico, se la fonte sono le note
    dettaglio: Optional[str] = None   # come è stato composto il totale


def _testo_per_ore(row: dict, events: List[dict], turns: List[dict]) -> str:
    """Tutto ciò che il meccanico ha scritto o dettato su questa commessa."""
    righe = [f"LAVORO RICHIESTO: {row.get('description') or '-'}"]
    for e in events:
        nota = (e.get("reason") or "").strip()
        if nota:
            righe.append(f"[{e['type']}] {nota}")
    for t in turns or []:
        if t.get("role") == "user" and (t.get("text") or "").strip():
            righe.append(f"[detta a voce] {t['text'].strip()}")
    return "\n".join(righe)


@api.get("/work-orders/{order_id}/ore-proposte", response_model=OreProposteOut)
async def ore_proposte(order_id: str, user: dict = Depends(get_current_user)):
    """Ore da proporre alla chiusura: le legge da ciò che il meccanico ha scritto durante il
    lavoro (più affidabile dei timbri, che restano aperti o non vengono premuti). Se nelle note
    non c'è nessun tempo, o se l'AI non risponde, ripiega sui timbri."""
    row = await _order_or_403(order_id, user)
    evs = await fetch("SELECT * FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC", order_id)
    minuti_timbri = _worker_minutes(evs)

    convo = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
    turns = convo["turns"] if convo else []
    if isinstance(turns, str):
        turns = json.loads(turns)

    testo = _testo_per_ore(dict(row), [dict(e) for e in evs], turns or [])
    ultimo_errore: Optional[Exception] = None
    for tentativo in range(3):
        try:
            raw = await ai.chat(
                [{"role": "system", "content": ai.SYSTEM_ORE_DA_NOTE}, {"role": "user", "content": testo}],
                json=True, max_tokens=300,
            )
            parsed = _extract_json_block(raw) or {}
            minuti = parsed.get("minuti")
            if isinstance(minuti, (int, float)) and 0 < int(minuti) <= 100000:
                return OreProposteOut(
                    minuti_proposti=int(minuti), minuti_timbri=minuti_timbri, fonte="note",
                    citazione=(parsed.get("citazione") or None), dettaglio=(parsed.get("dettaglio") or None),
                )
            # l'AI ha risposto e dice che un tempo non c'è: è una risposta valida
            return OreProposteOut(minuti_proposti=minuti_timbri, minuti_timbri=minuti_timbri, fonte="timbri")
        except Exception as e:
            ultimo_errore = e
            # il limite di richieste è passeggero: riprova, non è un "niente da leggere"
            if tentativo < 2:
                await asyncio.sleep(1.5 * (tentativo + 1))

    # l'AI non deve mai bloccare la chiusura di un lavoro: si ripiega sui timbri,
    # ma va detto che è stato un guasto, non che il meccanico non ha scritto le ore
    logger.warning(f"ore-proposte: AI non disponibile, uso i timbri ({ultimo_errore})")
    return OreProposteOut(minuti_proposti=minuti_timbri, minuti_timbri=minuti_timbri, fonte="errore")


class VehicleHistoryItem(BaseModel):
    id: str
    status: OrderStatus
    description: str
    esito: Optional[str] = None
    lavori_fatti: List[str] = Field(default_factory=list)
    workers: List[str] = Field(default_factory=list)
    created_at: datetime


@api.get("/work-orders/{order_id}/vehicle-history", response_model=List[VehicleHistoryItem])
async def vehicle_history(order_id: str, user: dict = Depends(get_current_user)):
    """Lavori passati sulla stessa targa: il veicolo che torna in officina ha una storia."""
    row = await _order_or_403(order_id, user)
    plate = (row.get("plate") or "").strip().upper().replace(" ", "")
    if not plate or plate in ("DA INSERIRE", "DAINSERIRE"):
        return []
    rows = await fetch(
        """SELECT * FROM work_orders
           WHERE UPPER(REPLACE(plate, ' ', '')) = $1 AND id != $2
           ORDER BY created_at DESC LIMIT 20""",
        plate, order_id
    )
    if not rows:
        return []
    user_rows = await fetch("SELECT id, full_name FROM users")
    uname = {u["id"]: u["full_name"] for u in user_rows}
    items: List[VehicleHistoryItem] = []
    for r in rows:
        scheda = r.get("scheda_tecnica") or {}
        if isinstance(scheda, str):
            scheda = json.loads(scheda)
        worker_ids = r.get("assigned_worker_ids") or []
        if isinstance(worker_ids, str):
            worker_ids = json.loads(worker_ids)
        esito_row = await fetchrow(
            "SELECT reason FROM work_events WHERE work_order_id=$1 AND type='COMPLETE' ORDER BY timestamp DESC LIMIT 1",
            r["id"]
        )
        items.append(VehicleHistoryItem(
            id=r["id"], status=r["status"], description=r["description"],
            esito=(esito_row or {}).get("reason"),
            lavori_fatti=scheda.get("lavori_fatti") or [],
            workers=[uname.get(w) for w in worker_ids if uname.get(w)],
            created_at=r["created_at"],
        ))
    return items


@api.put("/work-orders/{order_id}", response_model=WorkOrder)
async def update_work_order(order_id: str, body: WorkOrderUpdate, admin: dict = Depends(require_admin)):
    parts = []
    vals = []
    i = 1
    data = body.model_dump(exclude_unset=True)
    for field in ("plate", "vin", "customer", "vehicle", "description", "status"):
        if field in data and data[field] is not None:
            parts.append(f"{field}=${i}"); vals.append(data[field]); i += 1
    if "assigned_worker_ids" in data and data["assigned_worker_ids"] is not None:
        parts.append(f"assigned_worker_ids=${i}::jsonb"); vals.append(json.dumps(data["assigned_worker_ids"])); i += 1
    if not parts:
        raise HTTPException(status_code=400, detail="Nessun campo")
    parts.append(f"updated_at=${i}"); vals.append(now_utc()); i += 1
    vals.append(order_id)
    row = await fetchrow(
        f"UPDATE work_orders SET {', '.join(parts)} WHERE id=${i} RETURNING *",
        *vals
    )
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    return row_to_workorder(row)


@api.delete("/work-orders/{order_id}")
async def delete_work_order(order_id: str, admin: dict = Depends(require_admin)):
    await execute("DELETE FROM work_events WHERE work_order_id=$1", order_id)
    await execute("DELETE FROM order_photos WHERE work_order_id=$1", order_id)
    try:
        await execute("DELETE FROM case_embeddings WHERE work_order_id=$1", order_id)
    except Exception:
        pass
    try:
        await execute("DELETE FROM case_embeddings WHERE work_order_id=$1", order_id)
    except Exception:
        pass  # tabella assente se pgvector non è disponibile
    # rimuovi anche i file su disco
    photo_dir = UPLOADS_DIR / order_id
    if photo_dir.is_dir():
        for f in photo_dir.iterdir():
            f.unlink(missing_ok=True)
        photo_dir.rmdir()
    async with pool.acquire() as conn:
        res = await conn.execute("DELETE FROM work_orders WHERE id=$1", order_id)
    if res == "DELETE 0":
        raise HTTPException(status_code=404, detail="Non trovata")
    return {"ok": True}


# ---- Archivio fotografico commessa ----
class OrderPhoto(BaseModel):
    id: str
    work_order_id: str
    uploaded_by: str
    uploaded_by_name: str
    content_type: str
    size_bytes: int
    created_at: datetime
    caption: Optional[str] = None
    dati: Optional[dict] = None  # campi del libretto estratti dall'OCR
    kind: Optional[str] = None  # "libretto" per la foto del libretto scattata su INIZIA


_PHOTO_EXT = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
}
_VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}


async def _order_or_403(order_id: str, user: dict) -> dict:
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    if user["role"] == "worker" and user["id"] not in worker_ids:
        raise HTTPException(status_code=403, detail="Non assegnato")
    return row


def _photo_path(order_id: str, photo_id: str, content_type: str) -> Path:
    ext = _PHOTO_EXT.get(content_type, "bin")
    return UPLOADS_DIR / order_id / f"{photo_id}.{ext}"


async def _caption_photo(photo_id: str, data: bytes, content_type: str, kind: Optional[str] = None):
    """Mistral 'guarda' la foto una volta e ne scrive una didascalia, salvata per sempre.
    Così anche 'Chiedi all'AI' del titolare sa cosa c'è nelle foto senza rimandarle."""
    try:
        data_url = f"data:{content_type};base64,{base64.b64encode(data).decode()}"
        if kind == "libretto":
            campi, caption = await ai.leggi_libretto(data_url)
            if campi:
                await execute("UPDATE order_photos SET dati=$1::jsonb WHERE id=$2",
                              json.dumps(campi), photo_id)
        elif kind == "ricambio":
            # I codici dei pezzi montati: servono al titolare per comporre il preventivo
            campi, caption = await ai.leggi_ricambio(data_url)
            if campi:
                await execute("UPDATE order_photos SET dati=$1::jsonb WHERE id=$2",
                              json.dumps(campi), photo_id)
        else:
            caption = await ai.describe_image(data_url, kind=kind)
            # In officina si fotografa tutto: scatole, pezzi smontati, lavorazione. I codici
            # stanno spesso in una foto qualsiasi, non solo in quella scattata apposta.
            # Due strade, perche' sbagliano in modo diverso: prima l'OCR sull'immagine, poi
            # la didascalia appena scritta. Su una scatola di traverso l'OCR legge la scritta
            # del carrello dietro e perde l'etichetta, mentre la vista il codice l'ha letto.
            try:
                campi, _ = await ai.leggi_ricambio(data_url, ripiega_su_vision=False)
                if not (campi and campi.get("ricambi")) and caption:
                    campi = await ai.codici_da_testo(caption)
                if campi and campi.get("ricambi"):
                    await execute("UPDATE order_photos SET dati=$1::jsonb WHERE id=$2",
                                  json.dumps(campi), photo_id)
                    logger.info(f"foto {photo_id}: trovati {len(campi['ricambi'])} codici ricambio")
            except Exception as e:
                logger.warning(f"lettura codici da foto {photo_id}: {e}")
        if caption:
            await execute("UPDATE order_photos SET caption=$1 WHERE id=$2", caption[:800], photo_id)
            logger.info(f"didascalia foto {photo_id}: {caption[:60]}")
    except Exception as e:
        logger.warning(f"didascalia foto fallita per {photo_id}: {e}")


async def _salva_foto_base64(order_id: str, user: dict, raw: str, kind: Optional[str] = None) -> str:
    """Salva nell'archivio della commessa una foto arrivata come base64 (o data URL).
    Serve alla foto del libretto, che il meccanico scatta dentro la schermata INIZIA.
    Ritorna l'id della foto. Solleva HTTPException se il contenuto non va bene."""
    testo = (raw or "").strip()
    content_type = "image/jpeg"
    if testo.startswith("data:"):
        try:
            intestazione, testo = testo.split(",", 1)
            dichiarato = intestazione[5:].split(";")[0].lower()
            if dichiarato:
                content_type = dichiarato
        except ValueError:
            raise HTTPException(status_code=400, detail="Foto del libretto non leggibile")
    if content_type not in _PHOTO_EXT or content_type in _VIDEO_TYPES:
        raise HTTPException(status_code=415, detail=f"La foto del libretto deve essere un'immagine, non {content_type}")
    try:
        data = base64.b64decode(testo, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Foto del libretto non leggibile")
    if not data:
        raise HTTPException(status_code=400, detail="Foto del libretto vuota")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail=f"Foto troppo grande (max {MAX_PHOTO_BYTES // (1024*1024)}MB)")

    photo_id = str(uuid.uuid4())
    path = _photo_path(order_id, photo_id, content_type)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    await execute(
        """INSERT INTO order_photos (id, work_order_id, uploaded_by, uploaded_by_name, content_type, size_bytes, created_at, kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
        photo_id, order_id, user["id"], user["full_name"], content_type, len(data), now_utc(), kind,
    )
    asyncio.create_task(_caption_photo(photo_id, data, content_type, kind))
    return photo_id


@api.post("/work-orders/{order_id}/photos", response_model=OrderPhoto)
async def upload_order_photo(order_id: str, file: UploadFile = File(...),
                             kind: Optional[str] = None,
                             user: dict = Depends(get_current_user)):
    """kind='ricambio' fa leggere all'AI i codici articolo dalla scatola: finiscono
    nel riepilogo che il titolare riceve a lavoro finito, per il preventivo."""
    await _order_or_403(order_id, user)
    content_type = (file.content_type or "").lower()
    if content_type not in _PHOTO_EXT:
        raise HTTPException(status_code=415, detail=f"Formato non supportato: {content_type}. Usa JPEG/PNG/WebP o MP4/WebM/MOV.")
    data = await file.read()
    limit = MAX_VIDEO_BYTES if content_type in _VIDEO_TYPES else MAX_PHOTO_BYTES
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"File troppo grande (max {limit // (1024*1024)}MB)")
    if not data:
        raise HTTPException(status_code=400, detail="File vuoto")
    photo_id = str(uuid.uuid4())
    path = _photo_path(order_id, photo_id, content_type)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    now = now_utc()
    kind_pulito = (kind or "").strip().lower() or None
    if kind_pulito not in (None, "libretto", "ricambio"):
        kind_pulito = None
    await execute(
        """INSERT INTO order_photos (id, work_order_id, uploaded_by, uploaded_by_name, content_type, size_bytes, kind, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
        photo_id, order_id, user["id"], user["full_name"], content_type, len(data), kind_pulito, now,
    )
    # solo le immagini si "vedono": i video no
    if content_type not in _VIDEO_TYPES:
        asyncio.create_task(_caption_photo(photo_id, data, content_type, kind=kind_pulito))
    return OrderPhoto(
        id=photo_id, work_order_id=order_id, uploaded_by=user["id"], uploaded_by_name=user["full_name"],
        content_type=content_type, size_bytes=len(data), kind=kind_pulito, created_at=now,
    )


@api.get("/work-orders/{order_id}/photos", response_model=List[OrderPhoto])
async def list_order_photos(order_id: str, user: dict = Depends(get_current_user)):
    await _order_or_403(order_id, user)
    rows = await fetch(
        "SELECT * FROM order_photos WHERE work_order_id=$1 ORDER BY created_at DESC", order_id
    )
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("dati"), str):
            try: d["dati"] = json.loads(d["dati"])
            except Exception: d["dati"] = None
        out.append(OrderPhoto(**d))
    return out


@api.get("/photos/{photo_id}/file")
async def get_photo_file(photo_id: str, token: Optional[str] = None, omnius_key: Optional[str] = None, bearer: Optional[str] = Depends(oauth2)):
    # Accesso: 1) token utente (header o query per i tag <img>), 2) chiave Omnius (integrazione)
    row = await fetchrow("SELECT * FROM order_photos WHERE id=$1", photo_id)
    if not row:
        raise HTTPException(status_code=404, detail="Foto non trovata")
    if OMNIUS_KEY and omnius_key == OMNIUS_KEY:
        pass  # Omnius autorizzato via chiave dedicata
    else:
        user = await _user_from_token(bearer or token)
        await _order_or_403(row["work_order_id"], user)
    path = _photo_path(row["work_order_id"], photo_id, row["content_type"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File mancante sul server")
    return FileResponse(path, media_type=row["content_type"])


@api.delete("/photos/{photo_id}")
async def delete_photo(photo_id: str, user: dict = Depends(get_current_user)):
    """Il titolare cancella qualsiasi foto. Il meccanico cancella LE SUE — quella
    venuta mossa la rifà lui, senza chiedere il permesso a nessuno — ma non tocca
    quelle dei colleghi."""
    row = await fetchrow("SELECT * FROM order_photos WHERE id=$1", photo_id)
    if not row:
        raise HTTPException(status_code=404, detail="Foto non trovata")
    if user["role"] != "admin":
        await _order_or_403(row["work_order_id"], user)
        if row["uploaded_by"] != user["id"]:
            raise HTTPException(status_code=403, detail="Questa foto l'ha caricata un altro: non puoi eliminarla")
    _photo_path(row["work_order_id"], photo_id, row["content_type"]).unlink(missing_ok=True)
    await execute("DELETE FROM order_photos WHERE id=$1", photo_id)
    return {"ok": True}


# ---- Messaggi commessa (admin <-> operai) + notifiche push ----
class OrderMessage(BaseModel):
    id: str
    work_order_id: str
    sender_id: str
    sender_name: str
    sender_role: str
    text: str
    created_at: datetime
    edited_at: Optional[datetime] = None


class MessageIn(BaseModel):
    text: str


class UnreadOut(BaseModel):
    total: int
    by_order: dict


def _send_webpush_sync(sub: dict, payload: str):
    from pywebpush import webpush
    webpush(
        subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
        data=payload,
        vapid_private_key=VAPID_PRIVATE_KEY_FILE,
        vapid_claims={"sub": VAPID_SUB},
        ttl=3600,
    )


async def _push_to_users(user_ids: List[str], title: str, body: str, url: str = "/",
                         tag: str = "officina-msg", urgente: bool = False):
    """Invia una notifica push a tutti i dispositivi registrati degli utenti dati. Soft-fail.
    Con urgente=True la notifica resta sullo schermo finche non viene toccata: serve per il
    lavoro completato, che il titolare non deve perdersi."""
    if not VAPID_PRIVATE_KEY_FILE or not user_ids:
        return
    try:
        subs = await fetch("SELECT * FROM push_subscriptions WHERE user_id = ANY($1)", user_ids)
        if not subs:
            return
        payload = json.dumps({"title": title, "body": body[:160], "url": url,
                              "tag": tag, "urgente": urgente})
        for sub in subs:
            try:
                await asyncio.to_thread(_send_webpush_sync, dict(sub), payload)
            except Exception as e:
                msg = str(e)
                if "410" in msg or "404" in msg:  # iscrizione scaduta: pulizia
                    await execute("DELETE FROM push_subscriptions WHERE endpoint=$1", sub["endpoint"])
                else:
                    logger.warning(f"push fallita: {e}")
    except Exception as e:
        logger.warning(f"push: errore invio: {e}")


def fmt_durata_minuti(minuti: Optional[int]) -> str:
    """1h 30m — come lo direbbe un meccanico, non 90 minuti."""
    if not minuti or minuti <= 0:
        return "0m"
    h, m = divmod(int(minuti), 60)
    if h and m:
        return f"{h}h {m}m"
    return f"{h}h" if h else f"{m}m"


async def _telegram_notify(text: str):
    """Manda un messaggio a ogni titolare agganciato al bot. Soft-fail: se Telegram non
    risponde o non e' configurato, il lavoro del meccanico non ne risente in alcun modo."""
    if not TELEGRAM_BOT_TOKEN:
        return
    try:
        righe = await fetch("SELECT chat_id FROM telegram_chats WHERE attivo = TRUE")
        if not righe:
            return
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            for r in righe:
                chat_id = r["chat_id"]
                try:
                    resp = await client.post(
                        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                        json={
                            "chat_id": chat_id,
                            "text": text,
                            "parse_mode": "HTML",
                            "disable_web_page_preview": True,
                        },
                    )
                    if resp.status_code == 403:
                        # il titolare ha bloccato il bot: si disattiva invece di riprovare all'infinito
                        await execute("UPDATE telegram_chats SET attivo=FALSE WHERE chat_id=$1", chat_id)
                        logger.info(f"telegram: {chat_id} ha bloccato il bot, disattivato")
                    elif resp.status_code != 200:
                        logger.warning(f"telegram {chat_id}: risposta {resp.status_code}: {resp.text[:160]}")
                except Exception as e:
                    logger.warning(f"telegram {chat_id}: invio fallito: {e}")
    except Exception as e:
        logger.warning(f"telegram: errore generale: {e}")


def _esc(testo: str) -> str:
    """Telegram in modalita HTML: & < > vanno protetti o il messaggio non parte."""
    return (testo or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


MAX_FOTO_DA_LEGGERE = 15


async def _leggi_codici_arretrati(order_id: str):
    """Legge i codici dalle foto della commessa che nessuno ha ancora analizzato.

    Serve perche' in officina si fotografa tutto da sempre — scatole comprese — ma le foto
    caricate prima di questa funzione non sono mai passate dall'OCR. Alla chiusura del lavoro
    si recuperano, cosi il riepilogo non dice 'nessun ricambio' quando i codici sono li'."""
    try:
        foto = await fetch(
            """SELECT id, content_type, caption FROM order_photos
               WHERE work_order_id=$1 AND dati IS NULL AND content_type LIKE 'image/%'
               ORDER BY created_at ASC LIMIT $2""",
            order_id, MAX_FOTO_DA_LEGGERE,
        )
        for f in foto:
            try:
                campi = {}
                # la didascalia c'e' gia': si guarda prima quella, non costa una lettura nuova
                if f["caption"]:
                    campi = await ai.codici_da_testo(f["caption"])
                if not (campi and campi.get("ricambi")):
                    path = _photo_path(order_id, f["id"], f["content_type"])
                    if not path.exists():
                        continue
                    data_url = (f"data:{f['content_type']};base64,"
                                f"{base64.b64encode(path.read_bytes()).decode()}")
                    campi, _ = await ai.leggi_ricambio(data_url, ripiega_su_vision=False)
                if campi and campi.get("ricambi"):
                    await execute("UPDATE order_photos SET dati=$1::jsonb WHERE id=$2",
                                  json.dumps(campi), f["id"])
            except Exception as e:
                logger.warning(f"codici arretrati, foto {f['id']}: {e}")
    except Exception as e:
        logger.warning(f"codici arretrati per {order_id}: {e}")


async def _ricambi_della_commessa(order_id: str, scheda: dict) -> tuple[list, list]:
    """Cosa e stato montato davvero, da due fonti che si completano a vicenda:
    le spunte del meccanico sulla scheda e i codici letti dalle foto.
    Ritorna (voci spuntate a mano, voci lette dalle foto)."""
    a_mano = [str(x).strip() for x in (scheda.get("ricambi_sostituiti") or []) if str(x).strip()]

    # prima si recuperano le foto mai analizzate, poi si legge tutto
    await _leggi_codici_arretrati(order_id)

    dalle_foto: list = []
    try:
        # TUTTE le foto, non solo quelle scattate col pulsante RICAMBIO: il codice
        # sta spesso in una foto qualsiasi della lavorazione
        foto = await fetch(
            "SELECT dati FROM order_photos WHERE work_order_id=$1 AND dati IS NOT NULL",
            order_id,
        )
        visti = set()
        for f in foto:
            dati = f["dati"]
            if isinstance(dati, str):
                dati = json.loads(dati)
            for v in (dati or {}).get("ricambi") or []:
                if not isinstance(v, dict):
                    continue
                codice = (v.get("codice") or "").strip()
                if not codice or codice.upper() in visti:
                    continue
                visti.add(codice.upper())
                dalle_foto.append({
                    "codice": codice,
                    "marca": (v.get("marca") or "").strip(),
                    "descrizione": (v.get("descrizione") or "").strip(),
                    "quantita": v.get("quantita") or 1,
                })
    except Exception as e:
        logger.warning(f"lettura ricambi da foto: {e}")
    return a_mano, dalle_foto


async def _avvisa_lavoro_completato(order_id: str, worker_name: str):
    """A lavoro completato avvisa i titolari su tutti i canali: notifica push sul telefono
    e messaggio Telegram. Gira in background e non blocca mai la chiusura della commessa.

    Il messaggio Telegram porta tutto quello che serve a comporre il preventivo su STAR:
    lavori fatti, ricambi montati con i codici, e ore. Cosi il titolare non deve aprire
    l'app per sapere cosa mettere in fattura."""
    try:
        o = await fetchrow(
            """SELECT plate, customer, vehicle, description, minutes_effective, scheda_tecnica
               FROM work_orders WHERE id=$1""",
            order_id,
        )
        if not o:
            return

        targa = (o["plate"] or "").upper()
        veicolo = o["vehicle"] or ""
        cliente = o["customer"] or ""
        lavoro = (o["description"] or "").strip()
        minuti = o["minutes_effective"]
        ore = fmt_durata_minuti(minuti) if minuti else "da confermare"

        scheda = o["scheda_tecnica"] or {}
        if isinstance(scheda, str):
            scheda = json.loads(scheda)

        titolo = f"LAVORO COMPLETATO — {targa}"
        corpo = f"{worker_name} ha finito. {veicolo} · {ore}"

        admin_rows = await fetch("SELECT id FROM users WHERE role='admin'")
        admin_ids = [r["id"] for r in admin_rows]
        await _push_to_users(admin_ids, titolo, corpo, url=f"/order/{order_id}",
                             tag=f"completato-{order_id}", urgente=True)

        righe = [
            "🔧 <b>LAVORO COMPLETATO</b>",
            "",
            f"<b>Targa:</b> {_esc(targa)}",
        ]
        if veicolo:
            righe.append(f"<b>Veicolo:</b> {_esc(veicolo)}")
        if cliente:
            righe.append(f"<b>Cliente:</b> {_esc(cliente)}")
        righe += [
            f"<b>Meccanico:</b> {_esc(worker_name)}",
            f"<b>Ore lavorate:</b> {ore}",
        ]

        fatti = [str(x).strip() for x in (scheda.get("lavori_fatti") or []) if str(x).strip()]
        if fatti:
            righe += ["", "<b>LAVORO SVOLTO</b>"]
            righe += [f"• {_esc(v)}" for v in fatti[:12]]
        elif lavoro:
            righe += ["", "<b>LAVORO SVOLTO</b>", f"• {_esc(lavoro[:300])}"]

        a_mano, dalle_foto = await _ricambi_della_commessa(order_id, scheda)
        if a_mano or dalle_foto:
            righe += ["", "<b>RICAMBI MONTATI</b>"]
            for v in a_mano[:15]:
                righe.append(f"• {_esc(v)}")
            for v in dalle_foto[:15]:
                testo = f"<code>{_esc(v['codice'])}</code>"
                if v["marca"]:
                    testo = f"{_esc(v['marca'])} {testo}"
                if v["descrizione"]:
                    testo += f" — {_esc(v['descrizione'])}"
                try:
                    q = int(v["quantita"])
                except (TypeError, ValueError):
                    q = 1
                if q > 1:
                    testo += f" ×{q}"
                righe.append(f"• {testo}")
            if dalle_foto:
                righe.append("<i>I codici sono letti dalle foto: verificali prima di ordinare.</i>")
        else:
            righe += ["", "<i>Nessun ricambio registrato su questo lavoro.</i>"]

        # Il totale indicativo, se i documenti del fornitore ci sono. Se mancano si dice
        # cosa manca invece di sparare un numero credibile ma sbagliato.
        try:
            p = await calcola_preventivo(order_id)
            if p.get("ricambi") or p.get("ricambi_senza_costo") or p.get("ore"):
                righe += ["", "<b>PREVENTIVO INDICATIVO</b>"]
                for v in p["ricambi"][:15]:
                    nome = _esc(v.get("descrizione") or v.get("codice") or "ricambio")
                    q = f" ×{int(v['quantita'])}" if v.get("quantita", 1) > 1 else ""
                    fonte = (f", da catalogo di {v.get('prezzo_vecchio_di_giorni', 0)} giorni fa"
                             if v.get("da_catalogo") else "")
                    righe.append(
                        f"• {nome}{q} — <b>{v['totale']:.2f}</b> "
                        f"<i>(costo {v['costo']:.2f}, +{int(v['ricarico'])}%{fonte})</i>")
                for v in p.get("ricambi_senza_costo") or []:
                    marca = f"{v['marca']} " if v.get("marca") else ""
                    righe.append(
                        f"• {_esc(marca)}<code>{_esc(v['codice'])}</code> — "
                        f"<b>?</b> <i>(manca la bolla)</i>")
                for c in p.get("consumabili") or []:
                    unita = f" {c['unita']}" if c.get("unita") else ""
                    righe.append(
                        f"• {_esc(c['nome'])} {c['quantita']:g}{unita} — "
                        f"<b>{c['totale']:.2f}</b>")
                righe += [
                    "",
                    f"Ricambi <b>{p['ricambi_vendita']:.2f}</b>"
                    + (f" · Consumabili <b>{p['consumabili_totale']:.2f}</b>"
                       if p.get("consumabili_totale") else ""),
                    f"Manodopera {p['ore']:.1f}h × {p['tariffa_oraria']:.0f} = "
                    f"<b>{p['manodopera']:.2f}</b>",
                    f"Imponibile {p['imponibile']:.2f} + IVA {p['iva']:.2f}",
                    f"<b>TOTALE INDICATIVO {p['totale']:.2f} €</b>",
                    f"<i>margine sui ricambi {p['margine_ricambi']:.2f} €</i>",
                ]
                if p.get("mancanze"):
                    righe.append(f"<i>Da aggiungere: {_esc(', '.join(p['mancanze']))}</i>")
            else:
                righe += ["", "<i>Preventivo non calcolabile: nessun documento fornitore "
                              "caricato per questa targa.</i>"]
        except Exception as e:
            logger.warning(f"preventivo per il messaggio: {e}")

        righe += ["", f"{PUBLIC_BASE_URL}/order/{order_id}"]
        await _telegram_notify("\n".join(righe))
    except Exception as e:
        logger.warning(f"avviso completamento fallito: {e}")


# ---------------- Documenti fornitore e prezzi ----------------

DOCS_DIR = UPLOADS_DIR / "documenti"


async def _impostazioni_prezzi() -> dict:
    riga = await fetchrow("SELECT * FROM impostazioni_prezzi WHERE id=1")
    if not riga:
        return {"scaglioni": [], "tariffa_oraria": 37.0, "iva": 22.0, "consumabili": []}
    d = dict(riga)
    for c in ("scaglioni", "consumabili"):
        if isinstance(d.get(c), str):
            d[c] = json.loads(d[c])
    d["tariffa_oraria"] = float(d.get("tariffa_oraria") or 37)
    d["iva"] = float(d.get("iva") or 22)
    return d


def _ricarico_per(costo: float, scaglioni: list) -> float:
    """La percentuale che spetta a quel costo. Si applica al prezzo UNITARIO, non alla riga:
    altrimenti comprare piu' pezzi farebbe scendere il ricarico da solo."""
    for s in sorted(scaglioni, key=lambda x: (x.get("fino_a") is None, x.get("fino_a") or 0)):
        limite = s.get("fino_a")
        if limite is None or costo < float(limite):
            return float(s.get("ricarico") or 0)
    return 0.0


def _codice_norm(codice: str) -> str:
    """'512 0050 10', '512-005-010' e '512005010' sono lo stesso pezzo: i fornitori
    spaziano e trattano i codici come vogliono. Per confrontarli si guarda solo
    lettere e cifre."""
    return re.sub(r"[^A-Z0-9]", "", (codice or "").upper())


async def _aggiorna_catalogo(righe: list, fornitore: Optional[str], iva_inclusa: bool, iva: float):
    """Ogni riga letta da un documento entra nel catalogo. Il prezzo memorizzato e' sempre
    al NETTO: cosi' confrontare CDR (che stampa ivato) e GR Group ha senso."""
    for r in righe or []:
        if not isinstance(r, dict):
            continue
        codice = (r.get("codice") or "").strip()
        norm = _codice_norm(codice)
        if not norm:
            continue
        try:
            costo = float(r.get("costo_unitario") or 0)
        except (TypeError, ValueError):
            continue
        if costo <= 0:
            continue
        if iva_inclusa:
            costo = costo / (1 + iva / 100.0)
        try:
            await execute(
                """INSERT INTO catalogo_ricambi
                     (codice_norm, codice, descrizione, marca, costo, fornitore, origine, aggiornato_il)
                   VALUES ($1,$2,$3,$4,$5,$6,'bolla',$7)
                   ON CONFLICT (codice_norm) DO UPDATE SET
                     codice=$2,
                     descrizione=COALESCE(NULLIF($3,''), catalogo_ricambi.descrizione),
                     costo=$5, fornitore=$6, origine='bolla', aggiornato_il=$7""",
                norm, codice, (r.get("descrizione") or "").strip(), (r.get("marca") or "").strip() or None,
                round(costo, 2), fornitore, now_utc(),
            )
        except Exception as e:
            logger.warning(f"catalogo, codice {codice}: {e}")


async def _cerca_a_catalogo(codici: list) -> dict:
    """Il prezzo di riferimento per i codici dati. Ritorna {codice_norm: riga}."""
    norms = [_codice_norm(c) for c in codici if _codice_norm(c)]
    if not norms:
        return {}
    righe = await fetch(
        "SELECT * FROM catalogo_ricambi WHERE codice_norm = ANY($1)", norms)
    return {r["codice_norm"]: dict(r) for r in righe}


async def _righe_documenti_per_targa(targa: str) -> list:
    """Le righe di ricambio comprate per quella targa, da tutti i documenti caricati."""
    if not targa:
        return []
    docs = await fetch(
        """SELECT d.righe, d.targa, d.fornitore, d.numero, d.codice_fornitore,
                  COALESCE(f.iva_inclusa, FALSE) AS iva_inclusa
             FROM documenti_fornitore d
             LEFT JOIN fornitori f ON f.codice = d.codice_fornitore
            WHERE upper(d.targa)=upper($1)
               OR d.righe @> $2::jsonb""",
        targa, json.dumps([{"targa": targa.upper()}]),
    )
    fuori: list = []
    for d in docs:
        righe = d["righe"]
        if isinstance(righe, str):
            righe = json.loads(righe)
        for r in righe or []:
            if not isinstance(r, dict):
                continue
            # una riga vale per questa targa se la porta scritta, o se il documento intero e' suo
            sua = (r.get("targa") or "").upper() == targa.upper() or (
                not r.get("targa") and (d["targa"] or "").upper() == targa.upper())
            if sua:
                fuori.append({**r, "fornitore": d["fornitore"], "documento": d["numero"],
                              "iva_inclusa": d["iva_inclusa"]})
    return fuori


async def calcola_preventivo(order_id: str) -> dict:
    """Il totale indicativo di una commessa: ricambi dai documenti col ricarico, piu'
    manodopera. Dice sempre cosa gli manca, perche' un totale credibile ma incompleto
    e' peggio di nessun totale."""
    o = await fetchrow(
        "SELECT plate, minutes_effective, scheda_tecnica FROM work_orders WHERE id=$1", order_id)
    if not o:
        return {"disponibile": False, "motivo": "Commessa non trovata"}

    imp = await _impostazioni_prezzi()
    righe_doc = await _righe_documenti_per_targa(o["plate"] or "")

    voci: list = []
    tot_costo = tot_vendita = 0.0
    for r in righe_doc:
        try:
            costo = float(r.get("costo_unitario") or 0)
            q = float(r.get("quantita") or 1)
        except (TypeError, ValueError):
            continue
        if costo <= 0:
            continue
        # Alcuni fornitori (CDR) stampano i prezzi IVA COMPRESA, altri (GR Group) no.
        # Il ricarico va sempre sul netto: applicarlo a un prezzo ivato gonfia tutto del 22%.
        if r.get("iva_inclusa"):
            costo = costo / (1 + imp["iva"] / 100.0)
        perc = _ricarico_per(costo, imp["scaglioni"])
        prezzo = costo * (1 + perc / 100.0)
        tot_costo += costo * q
        tot_vendita += prezzo * q
        voci.append({
            "codice": r.get("codice"), "descrizione": r.get("descrizione"),
            "quantita": q, "costo": round(costo, 2), "ricarico": perc,
            "prezzo": round(prezzo, 2), "totale": round(prezzo * q, 2),
            "listino_fornitore": r.get("listino"),
            "fornitore": r.get("fornitore"),
            "costo_era_ivato": bool(r.get("iva_inclusa")),
        })

    # I pezzi che sappiamo montati dalle foto ma di cui non abbiamo il costo, perche' la
    # bolla non e' stata caricata. Vanno mostrati lo stesso: sapere che manca il prezzo di
    # un cilindretto frizione e' utile, credere che non ci fosse nessun ricambio no.
    scheda_r = o["scheda_tecnica"] or {}
    if isinstance(scheda_r, str):
        scheda_r = json.loads(scheda_r)
    _, dalle_foto = await _ricambi_della_commessa(order_id, scheda_r)
    codici_noti = {_codice_norm(str(v.get("codice") or "")) for v in voci}
    orfani = [f for f in dalle_foto
              if f.get("codice") and _codice_norm(f["codice"]) not in codici_noti]

    # Per i pezzi senza bolla si pesca il prezzo dal catalogo: puo' essere vecchio, ma un
    # prezzo vicino vale piu' di nessun prezzo. La bolla, quando c'e', ha sempre la
    # precedenza perche' e' aggiornata.
    catalogo = await _cerca_a_catalogo([f["codice"] for f in orfani])
    senza_costo: list = []
    for f in orfani:
        rif = catalogo.get(_codice_norm(f["codice"]))
        q = float(f.get("quantita") or 1)
        if rif and (rif.get("prezzo_vendita") or rif.get("costo")):
            giorni = (now_utc() - rif["aggiornato_il"]).days
            # Il prezzo di vendita del listino, quando c'e', batte il ricarico calcolato:
            # e' la scelta commerciale del titolare su quell'articolo, non una stima.
            if rif.get("prezzo_vendita"):
                prezzo = float(rif["prezzo_vendita"])
                costo = float(rif["costo"]) if rif.get("costo") else 0.0
                perc = round((prezzo / costo - 1) * 100) if costo else 0
                fonte = "listino"
            else:
                costo = float(rif["costo"])
                perc = _ricarico_per(costo, imp["scaglioni"])
                prezzo = costo * (1 + perc / 100.0)
                fonte = "catalogo"
            tot_costo += costo * q
            tot_vendita += prezzo * q
            voci.append({
                "codice": f["codice"],
                "descrizione": f.get("descrizione") or rif.get("descrizione"),
                "quantita": q, "costo": round(costo, 2), "ricarico": perc,
                "prezzo": round(prezzo, 2), "totale": round(prezzo * q, 2),
                "listino_fornitore": None, "fornitore": rif.get("fornitore"),
                "costo_era_ivato": False,
                "da_catalogo": True, "fonte_prezzo": fonte,
                "prezzo_vecchio_di_giorni": giorni,
            })
        else:
            senza_costo.append({
                "codice": f["codice"], "descrizione": f.get("descrizione") or "",
                "marca": f.get("marca") or "", "quantita": q,
            })

    minuti = o["minutes_effective"] or 0
    ore = minuti / 60.0
    manodopera = ore * imp["tariffa_oraria"]

    # Consumabili: l'olio non arriva da nessuna bolla per commessa, sta nel fusto.
    # La quantita' la dichiara il meccanico alla chiusura, il prezzo e' gia' finito.
    scheda = o["scheda_tecnica"] or {}
    if isinstance(scheda, str):
        scheda = json.loads(scheda)
    listino_cons = {c.get("nome", "").lower(): c for c in (imp.get("consumabili") or [])}
    consumabili: list = []
    tot_consumabili = 0.0
    for c in (scheda.get("consumabili") or []):
        if not isinstance(c, dict):
            continue
        nome = str(c.get("nome") or "").strip()
        try:
            q = float(c.get("quantita") or 0)
        except (TypeError, ValueError):
            continue
        if not nome or q <= 0:
            continue
        rif = listino_cons.get(nome.lower(), {})
        prezzo = float(c.get("prezzo") or rif.get("prezzo") or 0)
        if prezzo <= 0:
            continue
        tot_consumabili += prezzo * q
        consumabili.append({"nome": nome, "quantita": q, "unita": rif.get("unita") or c.get("unita"),
                            "prezzo": round(prezzo, 2), "totale": round(prezzo * q, 2)})

    imponibile = tot_vendita + manodopera + tot_consumabili
    iva = imponibile * imp["iva"] / 100.0

    mancanze = []
    if senza_costo:
        elenco = ", ".join(f"{v['codice']}" for v in senza_costo[:4])
        mancanze.append(f"manca la bolla per {len(senza_costo)} ricambio/i già montati ({elenco})")
    elif not voci:
        mancanze.append("nessun documento fornitore caricato per questa targa")
    if not minuti:
        mancanze.append("ore non confermate")
    if not consumabili:
        mancanze.append("olio e consumabili non dichiarati")

    return {
        "disponibile": bool(voci) or bool(minuti),
        "targa": o["plate"],
        "ricambi": voci,
        "ricambi_senza_costo": senza_costo,
        "ricambi_costo": round(tot_costo, 2),
        "ricambi_vendita": round(tot_vendita, 2),
        "margine_ricambi": round(tot_vendita - tot_costo, 2),
        "consumabili": consumabili,
        "consumabili_totale": round(tot_consumabili, 2),
        "ore": round(ore, 2),
        "tariffa_oraria": imp["tariffa_oraria"],
        "manodopera": round(manodopera, 2),
        "imponibile": round(imponibile, 2),
        "iva_perc": imp["iva"],
        "iva": round(iva, 2),
        "totale": round(imponibile + iva, 2),
        "mancanze": mancanze,
    }


class RigaDocumento(BaseModel):
    codice: Optional[str] = None
    descrizione: Optional[str] = None
    quantita: Optional[float] = 1
    costo_unitario: Optional[float] = None
    listino: Optional[float] = None
    importo: Optional[float] = None
    targa: Optional[str] = None


class DocumentoOut(BaseModel):
    id: str
    fornitore: Optional[str] = None
    codice_fornitore: Optional[str] = None
    numero: Optional[str] = None
    data_doc: Optional[date] = None
    targa: Optional[str] = None
    righe: List[dict] = Field(default_factory=list)
    imponibile: Optional[float] = None
    totale: Optional[float] = None
    verifica: Optional[dict] = None
    caricato_da_nome: Optional[str] = None
    created_at: datetime


class DocumentoUpdate(BaseModel):
    fornitore: Optional[str] = None
    numero: Optional[str] = None
    data_doc: Optional[str] = None
    targa: Optional[str] = None
    righe: Optional[List[RigaDocumento]] = None


def _riga_documento(row: dict) -> DocumentoOut:
    d = dict(row)
    for c in ("righe", "verifica"):
        if isinstance(d.get(c), str):
            d[c] = json.loads(d[c])
    for c in ("imponibile", "totale"):
        if d.get(c) is not None:
            d[c] = float(d[c])
    return DocumentoOut(**{k: d.get(k) for k in DocumentoOut.model_fields})


@api.post("/documenti", response_model=DocumentoOut)
async def carica_documento(file: UploadFile = File(...), admin: dict = Depends(require_admin)):
    """Il titolare fotografa la bolla del fornitore: l'AI ne estrae le righe coi costi.

    E' la sorgente dei costi, quindi di tutto il calcolo del preventivo. La foto originale
    resta salvata: se un numero non torna, si riguarda la carta."""
    content_type = (file.content_type or "").lower()
    if content_type not in _PHOTO_EXT:
        raise HTTPException(status_code=415, detail=f"Formato non supportato: {content_type}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="File vuoto")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail=f"Foto troppo grande (max {MAX_PHOTO_BYTES//(1024*1024)}MB)")

    doc_id = str(uuid.uuid4())
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    path = DOCS_DIR / f"{doc_id}.{_PHOTO_EXT[content_type]}"
    path.write_bytes(data)

    data_url = f"data:{content_type};base64,{base64.b64encode(data).decode()}"
    try:
        letto = await ai.leggi_documento_fornitore(data_url)
    except Exception as e:
        logger.exception("lettura documento fallita")
        raise HTTPException(status_code=502, detail=f"Non riesco a leggere il documento: {e}")
    if letto.get("errore"):
        raise HTTPException(status_code=422, detail=letto["errore"])

    # la sigla a penna (F1, F2...) e' la parola del titolare: vince sul nome stampato
    fornitore = letto.get("fornitore")
    codice = (letto.get("codice_fornitore") or "").strip().upper() or None
    if codice:
        f = await fetchrow("SELECT nome FROM fornitori WHERE codice=$1", codice)
        if f:
            fornitore = f["nome"]

    righe = [r for r in (letto.get("righe") or []) if isinstance(r, dict)]
    verifica = ai.verifica_documento(letto)

    data_doc = None
    if letto.get("data"):
        try:
            data_doc = date.fromisoformat(str(letto["data"])[:10])
        except ValueError:
            pass

    await execute(
        """INSERT INTO documenti_fornitore
           (id, fornitore, codice_fornitore, numero, data_doc, targa, righe, imponibile,
            totale, verifica, content_type, caricato_da, caricato_da_nome, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$14)""",
        doc_id, fornitore, codice, letto.get("numero"), data_doc,
        (letto.get("targa") or "").upper() or None, json.dumps(righe),
        letto.get("imponibile"), letto.get("totale_documento"), json.dumps(verifica),
        content_type, admin["id"], admin["full_name"], now_utc(),
    )
    # Ogni riga entra anche nel catalogo: cosi' un pezzo preso dal magazzino, senza bolla
    # per quella commessa, un prezzo di riferimento ce l'ha comunque.
    iva_inclusa = False
    if codice:
        f = await fetchrow("SELECT iva_inclusa FROM fornitori WHERE codice=$1", codice)
        iva_inclusa = bool(f and f["iva_inclusa"])
    imp = await _impostazioni_prezzi()
    await _aggiorna_catalogo(righe, fornitore, iva_inclusa, imp["iva"])

    logger.info(f"documento {doc_id}: {len(righe)} righe, verifica {verifica.get('stato')}")
    return _riga_documento(dict(await fetchrow("SELECT * FROM documenti_fornitore WHERE id=$1", doc_id)))


@api.get("/documenti", response_model=List[DocumentoOut])
async def lista_documenti(targa: Optional[str] = None, limite: int = 50,
                          admin: dict = Depends(require_admin)):
    if targa:
        righe = await fetch(
            "SELECT * FROM documenti_fornitore WHERE upper(targa)=upper($1) ORDER BY created_at DESC",
            targa)
    else:
        righe = await fetch(
            "SELECT * FROM documenti_fornitore ORDER BY created_at DESC LIMIT $1",
            max(1, min(limite, 200)))
    return [_riga_documento(dict(r)) for r in righe]


@api.get("/documenti/{doc_id}/file")
async def file_documento(doc_id: str, admin: dict = Depends(require_admin)):
    row = await fetchrow("SELECT content_type FROM documenti_fornitore WHERE id=$1", doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Documento non trovato")
    path = DOCS_DIR / f"{doc_id}.{_PHOTO_EXT.get(row['content_type'], 'jpg')}"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Immagine non trovata")
    return FileResponse(path, media_type=row["content_type"])


@api.patch("/documenti/{doc_id}", response_model=DocumentoOut)
async def correggi_documento(doc_id: str, body: DocumentoUpdate, admin: dict = Depends(require_admin)):
    """Il titolare corregge quello che l'AI ha letto male, o assegna la targa mancante."""
    row = await fetchrow("SELECT id FROM documenti_fornitore WHERE id=$1", doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Documento non trovato")
    parti, vals, i = [], [], 1
    if body.fornitore is not None:
        parti.append(f"fornitore=${i}"); vals.append(body.fornitore.strip() or None); i += 1
    if body.numero is not None:
        parti.append(f"numero=${i}"); vals.append(body.numero.strip() or None); i += 1
    if body.targa is not None:
        parti.append(f"targa=${i}"); vals.append(body.targa.strip().upper() or None); i += 1
    if body.data_doc is not None:
        try:
            parti.append(f"data_doc=${i}"); vals.append(date.fromisoformat(body.data_doc)); i += 1
        except ValueError:
            raise HTTPException(status_code=400, detail="Data non valida")
    if body.righe is not None:
        righe = [r.model_dump() for r in body.righe]
        parti.append(f"righe=${i}::jsonb"); vals.append(json.dumps(righe)); i += 1
        parti.append(f"verifica=${i}::jsonb")
        vals.append(json.dumps(ai.verifica_documento({"righe": righe}))); i += 1
    if not parti:
        return _riga_documento(dict(await fetchrow("SELECT * FROM documenti_fornitore WHERE id=$1", doc_id)))
    parti.append(f"updated_at=${i}"); vals.append(now_utc()); i += 1
    vals.append(doc_id)
    await execute(f"UPDATE documenti_fornitore SET {', '.join(parti)} WHERE id=${i}", *vals)
    return _riga_documento(dict(await fetchrow("SELECT * FROM documenti_fornitore WHERE id=$1", doc_id)))


@api.delete("/documenti/{doc_id}")
async def elimina_documento(doc_id: str, admin: dict = Depends(require_admin)):
    row = await fetchrow("SELECT content_type FROM documenti_fornitore WHERE id=$1", doc_id)
    if not row:
        raise HTTPException(status_code=404, detail="Documento non trovato")
    await execute("DELETE FROM documenti_fornitore WHERE id=$1", doc_id)
    path = DOCS_DIR / f"{doc_id}.{_PHOTO_EXT.get(row['content_type'], 'jpg')}"
    path.unlink(missing_ok=True)
    return {"ok": True}


class VoceCatalogoIn(BaseModel):
    codice: str
    descrizione: Optional[str] = None
    marca: Optional[str] = None
    costo: Optional[float] = None            # quanto la paga l'officina
    prezzo_vendita: Optional[float] = None   # quanto la vende, se gia' deciso a listino
    fornitore: Optional[str] = None
    iva_inclusa: bool = False


@api.get("/catalogo")
async def lista_catalogo(cerca: Optional[str] = None, limite: int = 100,
                         admin: dict = Depends(require_admin)):
    """Il catalogo dei prezzi di riferimento, usato quando la bolla non c'e'."""
    if cerca:
        righe = await fetch(
            """SELECT * FROM catalogo_ricambi
                WHERE codice_norm LIKE '%' || $1 || '%' OR descrizione ILIKE '%' || $2 || '%'
                ORDER BY aggiornato_il DESC LIMIT $3""",
            _codice_norm(cerca), cerca, max(1, min(limite, 500)))
    else:
        righe = await fetch(
            "SELECT * FROM catalogo_ricambi ORDER BY aggiornato_il DESC LIMIT $1",
            max(1, min(limite, 500)))
    return [{**dict(r), "costo": float(r["costo"]) if r["costo"] is not None else None}
            for r in righe]


@api.post("/catalogo")
async def salva_catalogo(voci: List[VoceCatalogoIn], admin: dict = Depends(require_admin)):
    """Carica in blocco i prezzi di magazzino. Marcati come origine 'magazzino': restano
    finche' una bolla vera non li sostituisce con un prezzo aggiornato."""
    imp = await _impostazioni_prezzi()
    inseriti = 0
    for v in voci:
        norm = _codice_norm(v.codice)
        if not norm or not (v.costo or v.prezzo_vendita):
            continue
        div = (1 + imp["iva"] / 100.0) if v.iva_inclusa else 1.0
        costo = round(v.costo / div, 2) if v.costo else None
        vendita = round(v.prezzo_vendita / div, 2) if v.prezzo_vendita else None
        await execute(
            """INSERT INTO catalogo_ricambi
                 (codice_norm, codice, descrizione, marca, costo, prezzo_vendita,
                  fornitore, origine, aggiornato_il)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'magazzino',$8)
               ON CONFLICT (codice_norm) DO UPDATE SET
                 codice=$2,
                 descrizione=COALESCE(NULLIF($3,''), catalogo_ricambi.descrizione),
                 marca=COALESCE($4, catalogo_ricambi.marca),
                 costo=COALESCE($5, catalogo_ricambi.costo),
                 prezzo_vendita=COALESCE($6, catalogo_ricambi.prezzo_vendita),
                 fornitore=COALESCE($7, catalogo_ricambi.fornitore),
                 origine='magazzino', aggiornato_il=$8""",
            norm, v.codice.strip(), (v.descrizione or "").strip(),
            (v.marca or "").strip() or None, costo, vendita,
            (v.fornitore or "").strip() or None, now_utc(),
        )
        inseriti += 1
    totale = await fetchrow("SELECT count(*) AS n FROM catalogo_ricambi")
    return {"ok": True, "caricate": inseriti, "totale_catalogo": totale["n"]}


@api.delete("/catalogo/{codice}")
async def elimina_da_catalogo(codice: str, admin: dict = Depends(require_admin)):
    await execute("DELETE FROM catalogo_ricambi WHERE codice_norm=$1", _codice_norm(codice))
    return {"ok": True}


class FornitoreIn(BaseModel):
    codice: str
    nome: str
    note: Optional[str] = None


@api.get("/fornitori")
async def lista_fornitori(admin: dict = Depends(require_admin)):
    return [dict(r) for r in await fetch("SELECT * FROM fornitori ORDER BY codice")]


@api.post("/fornitori")
async def salva_fornitore(body: FornitoreIn, admin: dict = Depends(require_admin)):
    codice = body.codice.strip().upper()
    if not codice or not body.nome.strip():
        raise HTTPException(status_code=400, detail="Servono sigla e nome")
    await execute(
        """INSERT INTO fornitori (codice, nome, note) VALUES ($1,$2,$3)
           ON CONFLICT (codice) DO UPDATE SET nome=$2, note=$3""",
        codice, body.nome.strip(), (body.note or "").strip() or None)
    return {"ok": True}


@api.delete("/fornitori/{codice}")
async def elimina_fornitore(codice: str, admin: dict = Depends(require_admin)):
    await execute("DELETE FROM fornitori WHERE codice=$1", codice.upper())
    return {"ok": True}


@api.get("/work-orders/{order_id}/preventivo")
async def preventivo_commessa(order_id: str, admin: dict = Depends(require_admin)):
    """Il totale indicativo, da girare su STAR."""
    return await calcola_preventivo(order_id)


class TelegramChatOut(BaseModel):
    chat_id: str
    nome: Optional[str] = None
    username: Optional[str] = None
    attivo: bool


class TelegramStatoOut(BaseModel):
    configurato: bool          # il bot esiste (token presente sul server)
    bot_username: Optional[str] = None
    agganciati: List[TelegramChatOut]


@api.get("/telegram/stato", response_model=TelegramStatoOut)
async def telegram_stato(admin: dict = Depends(require_admin)):
    """Chi riceve gli avvisi su Telegram in questo momento."""
    if not TELEGRAM_BOT_TOKEN:
        return TelegramStatoOut(configurato=False, agganciati=[])

    bot_username = None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getMe")
            if r.status_code == 200:
                bot_username = (r.json().get("result") or {}).get("username")
    except Exception as e:
        logger.warning(f"telegram getMe: {e}")

    righe = await fetch("SELECT chat_id, nome, username, attivo FROM telegram_chats ORDER BY aggiunto_il")
    return TelegramStatoOut(
        configurato=True,
        bot_username=bot_username,
        agganciati=[TelegramChatOut(**dict(r)) for r in righe],
    )


@api.post("/telegram/aggancia", response_model=TelegramStatoOut)
async def telegram_aggancia(admin: dict = Depends(require_admin)):
    """Registra chiunque abbia scritto al bot in chat privata e non sia gia in elenco.

    Il titolare apre il bot su Telegram, preme AVVIA, poi tocca questo pulsante nell'app:
    da quel momento riceve gli avvisi. Nessuna configurazione sul server."""
    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(status_code=400, detail="Telegram non configurato: manca il token del bot")

    try:
        import httpx
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
                params={"limit": 100, "allowed_updates": '["message"]'},
            )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Telegram ha risposto {r.status_code}")
        updates = (r.json() or {}).get("result") or []
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"telegram getUpdates: {e}")
        raise HTTPException(status_code=502, detail="Non riesco a contattare Telegram")

    nuovi = 0
    for u in updates:
        chat = ((u.get("message") or {}).get("chat")) or {}
        # solo chat private: nei gruppi la modalita privacy impedisce al bot di vedere i messaggi
        if chat.get("type") != "private" or not chat.get("id"):
            continue
        nome = " ".join(x for x in [chat.get("first_name"), chat.get("last_name")] if x) or None
        esiste = await fetchrow("SELECT chat_id FROM telegram_chats WHERE chat_id=$1", str(chat["id"]))
        if esiste:
            await execute("UPDATE telegram_chats SET attivo=TRUE, nome=$2, username=$3 WHERE chat_id=$1",
                          str(chat["id"]), nome, chat.get("username"))
        else:
            await execute(
                "INSERT INTO telegram_chats (chat_id, nome, username) VALUES ($1,$2,$3)",
                str(chat["id"]), nome, chat.get("username"),
            )
            nuovi += 1

    if nuovi:
        await _telegram_notify(
            "✅ <b>Collegamento riuscito</b>\n\n"
            "Da adesso ricevi qui un avviso ogni volta che un meccanico completa un lavoro.\n\n"
            "<i>Suggerimento: dalle impostazioni di questa chat puoi scegliere una suoneria "
            "personalizzata, anche lunga, così te ne accorgi anche col telefono in tasca.</i>"
        )

    return await telegram_stato(admin)


@api.delete("/telegram/{chat_id}")
async def telegram_rimuovi(chat_id: str, admin: dict = Depends(require_admin)):
    """Smette di mandare avvisi a questo destinatario."""
    await execute("DELETE FROM telegram_chats WHERE chat_id=$1", chat_id)
    return {"ok": True}


@api.get("/push/vapid-public")
async def vapid_public(user: dict = Depends(get_current_user)):
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=503, detail="Notifiche non configurate")
    return {"key": VAPID_PUBLIC_KEY}


@api.post("/push/subscribe")
async def push_subscribe(body: dict, user: dict = Depends(get_current_user)):
    endpoint = (body.get("endpoint") or "").strip()
    keys = body.get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(status_code=400, detail="Iscrizione push non valida")
    await execute(
        """INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (endpoint) DO UPDATE SET user_id=$2, p256dh=$3, auth=$4""",
        endpoint, user["id"], keys["p256dh"], keys["auth"], now_utc()
    )
    return {"ok": True}


@api.get("/work-orders/{order_id}/messages", response_model=List[OrderMessage])
async def list_messages(order_id: str, user: dict = Depends(get_current_user)):
    await _order_or_403(order_id, user)
    rows = await fetch(
        "SELECT * FROM order_messages WHERE work_order_id=$1 ORDER BY created_at ASC LIMIT 500", order_id
    )
    # leggere i messaggi li marca come letti per questo utente
    await execute(
        """INSERT INTO message_reads (user_id, work_order_id, last_read_at) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, work_order_id) DO UPDATE SET last_read_at=$3""",
        user["id"], order_id, now_utc()
    )
    return [OrderMessage(**dict(r)) for r in rows]


@api.post("/work-orders/{order_id}/messages", response_model=OrderMessage)
async def send_message(order_id: str, body: MessageIn, user: dict = Depends(get_current_user)):
    row = await _order_or_403(order_id, user)
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Messaggio vuoto")
    if len(text) > 2000:
        raise HTTPException(status_code=413, detail="Messaggio troppo lungo (max 2000)")
    msg_id = str(uuid.uuid4())
    now = now_utc()
    await execute(
        """INSERT INTO order_messages (id, work_order_id, sender_id, sender_name, sender_role, text, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)""",
        msg_id, order_id, user["id"], user["full_name"], user["role"], text, now
    )
    # chi mando a notificare: se scrive l'admin -> operai assegnati; se scrive l'operaio -> tutti gli admin
    if user["role"] == "admin":
        worker_ids = row.get("assigned_worker_ids") or []
        if isinstance(worker_ids, str):
            worker_ids = json.loads(worker_ids)
        recipients = [w for w in worker_ids if w != user["id"]]
    else:
        admin_rows = await fetch("SELECT id FROM users WHERE role='admin'")
        recipients = [a["id"] for a in admin_rows]
    asyncio.create_task(_push_to_users(
        recipients,
        f"Messaggio da {user['full_name']}",
        f"[{row['plate']}] {text}",
    ))
    # se la commessa è già completata, il nuovo messaggio aggiorna il caso nella memoria storica
    if row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(order_id))
    return OrderMessage(
        id=msg_id, work_order_id=order_id, sender_id=user["id"], sender_name=user["full_name"],
        sender_role=user["role"], text=text, created_at=now,
    )


class MessageEditIn(BaseModel):
    text: str


@api.put("/messages/{message_id}", response_model=OrderMessage)
async def edit_message(message_id: str, body: MessageEditIn, user: dict = Depends(get_current_user)):
    """Modifica un messaggio: solo l'autore può farlo. Il messaggio resta marcato '(modificato)'."""
    msg = await fetchrow("SELECT * FROM order_messages WHERE id=$1", message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Messaggio non trovato")
    if msg["sender_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Puoi modificare solo i tuoi messaggi")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Messaggio vuoto")
    if len(text) > 2000:
        raise HTTPException(status_code=413, detail="Messaggio troppo lungo (max 2000)")
    now = now_utc()
    await execute("UPDATE order_messages SET text=$1, edited_at=$2 WHERE id=$3", text, now, message_id)
    row = await fetchrow("SELECT status FROM work_orders WHERE id=$1", msg["work_order_id"])
    if row and row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(msg["work_order_id"]))
    return OrderMessage(**{**dict(msg), "text": text, "edited_at": now})


@api.delete("/messages/{message_id}")
async def delete_message(message_id: str, user: dict = Depends(get_current_user)):
    """Cancella un messaggio: solo l'autore può farlo."""
    msg = await fetchrow("SELECT * FROM order_messages WHERE id=$1", message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Messaggio non trovato")
    if msg["sender_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Puoi cancellare solo i tuoi messaggi")
    await execute("DELETE FROM order_messages WHERE id=$1", message_id)
    row = await fetchrow("SELECT status FROM work_orders WHERE id=$1", msg["work_order_id"])
    if row and row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(msg["work_order_id"]))
    return {"ok": True}


class TurnEditIn(BaseModel):
    text: str


@api.put("/work-orders/{order_id}/conversation/turns/{turn_index}", response_model=ConversationOut)
async def edit_conversation_turn(order_id: str, turn_index: int, body: TurnEditIn, user: dict = Depends(get_current_user)):
    """Modifica un proprio messaggio nel dialogo AI (es. refuso del vocale).
    Solo turni 'user' propri; il turno resta marcato con edited_at. L'AI non ri-risponde:
    la correzione vale per il registro, il report e la memoria storica."""
    await _order_or_403(order_id, user)
    convo = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
    if not convo:
        raise HTTPException(status_code=404, detail="Conversazione non trovata")
    turns = convo["turns"]
    if isinstance(turns, str):
        turns = json.loads(turns)
    turns = turns or []
    if turn_index < 0 or turn_index >= len(turns):
        raise HTTPException(status_code=404, detail="Turno non trovato")
    turn = turns[turn_index]
    if turn.get("role") != "user":
        raise HTTPException(status_code=403, detail="Puoi modificare solo i tuoi messaggi, non le risposte dell'AI")
    if turn.get("worker_id") and turn["worker_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Puoi modificare solo i tuoi messaggi")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Testo vuoto")
    now = now_utc()
    turn["text"] = text
    turn["edited_at"] = now.isoformat()
    await execute(
        "UPDATE conversations SET turns=$1::jsonb, updated_at=$2 WHERE work_order_id=$3",
        json.dumps(turns), now, order_id
    )
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if row and row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(order_id))
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    parsed_turns = [ConversationTurn(**{k: v for k, v in t.items() if k in ConversationTurn.model_fields}) for t in turns]
    return ConversationOut(work_order_id=order_id, scheda_tecnica=SchedaTecnica(**scheda_raw), turns=parsed_turns)


@api.delete("/work-orders/{order_id}/conversation/turns/{turn_index}", response_model=ConversationOut)
async def delete_conversation_turn(order_id: str, turn_index: int, user: dict = Depends(get_current_user)):
    """Cancella un proprio messaggio del dialogo AI, anche un vocale trascritto.
    Solo turni 'user' propri; le risposte dell'AI non si toccano. La cancellazione vale
    per il registro, il report e la memoria storica (che si aggiorna solo se la commessa è chiusa)."""
    await _order_or_403(order_id, user)
    convo = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
    if not convo:
        raise HTTPException(status_code=404, detail="Conversazione non trovata")
    turns = convo["turns"]
    if isinstance(turns, str):
        turns = json.loads(turns)
    turns = turns or []
    if turn_index < 0 or turn_index >= len(turns):
        raise HTTPException(status_code=404, detail="Turno non trovato")
    turn = turns[turn_index]
    if turn.get("role") != "user":
        raise HTTPException(status_code=403, detail="Puoi cancellare solo i tuoi messaggi, non le risposte dell'AI")
    if turn.get("worker_id") and turn["worker_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Puoi cancellare solo i tuoi messaggi")
    del turns[turn_index]
    now = now_utc()
    await execute(
        "UPDATE conversations SET turns=$1::jsonb, updated_at=$2 WHERE work_order_id=$3",
        json.dumps(turns), now, order_id
    )
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if row and row["status"] == "completed":
        asyncio.create_task(_upsert_case_embedding(order_id))
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    parsed_turns = [ConversationTurn(**{k: v for k, v in t.items() if k in ConversationTurn.model_fields}) for t in turns]
    return ConversationOut(work_order_id=order_id, scheda_tecnica=SchedaTecnica(**scheda_raw), turns=parsed_turns)


@api.get("/messages/unread", response_model=UnreadOut)
async def unread_messages(user: dict = Depends(get_current_user)):
    """Conteggio non letti per l'utente: messaggi altrui nelle commesse a cui ha accesso,
    successivi al suo ultimo accesso alla chat di quella commessa."""
    if user["role"] == "worker":
        access_cond = "w.assigned_worker_ids @> to_jsonb(ARRAY[$1])"
    else:
        access_cond = "$1 = $1"  # admin: tutte
    rows = await fetch(
        f"""SELECT m.work_order_id, count(*) AS n
            FROM order_messages m
            JOIN work_orders w ON w.id = m.work_order_id
            LEFT JOIN message_reads r ON r.work_order_id = m.work_order_id AND r.user_id = $1
            WHERE m.sender_id != $1
              AND {access_cond}
              AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
            GROUP BY m.work_order_id""",
        user["id"]
    )
    by_order = {r["work_order_id"]: r["n"] for r in rows}
    return UnreadOut(total=sum(by_order.values()), by_order=by_order)


# ---- Work Events ----
async def _ai_interpret_reason(reason: str, event_type: str) -> Optional[str]:
    if not reason:
        return None
    try:
        content = await ai.chat(
            [
                {"role": "system", "content": ai.SYSTEM_EVENT_INTERPRET},
                {"role": "user", "content": f"Evento: {event_type}\nMotivo dell'operaio: {reason}"},
            ],
            max_tokens=100,
        )
        return content.strip() or None
    except Exception as e:
        logger.warning(f"AI interpret failed: {e}")
        return None


@api.post("/work-orders/{order_id}/events", response_model=WorkEvent)
async def add_event(order_id: str, body: WorkEventCreate, user: dict = Depends(get_current_user)):
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    if user["role"] == "worker" and user["id"] not in worker_ids:
        raise HTTPException(status_code=403, detail="Non assegnato a questa commessa")

    # I km si chiedono su INIZIA. Se il contachilometri non è leggibile (auto già
    # sul ponte, arrivata col carroattrezzi…) il meccanico può rinviarli alla
    # chiusura scrivendo il perché: in quel caso tornano obbligatori su COMPLETA.
    # Chi li ha già dati all'inizio non se li vede più chiedere.
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    km_registrati = str(scheda_raw.get("km") or "").strip()

    km_digits = re.sub(r"[^0-9]", "", body.km or "")
    km_valido = 1 <= len(km_digits) <= 7
    km_rinvio = (body.km_deferred_reason or "").strip() or None
    km_clean = None

    if body.type == "START":
        # Dopo i km serve la foto del libretto: si scatta una volta per commessa e
        # senza quella il lavoro non parte.
        libretto_esistente = await fetchrow(
            "SELECT id FROM order_photos WHERE work_order_id=$1 AND kind='libretto' LIMIT 1", order_id
        )
        if not libretto_esistente and not (body.libretto_base64 or "").strip():
            raise HTTPException(
                status_code=400,
                detail=("Scatta la foto del libretto per iniziare il lavoro. "
                        "Se non vedi il campo, ricarica la pagina."),
            )
        if km_digits:
            if not km_valido:
                raise HTTPException(status_code=400, detail="Chilometraggio non valido")
            km_clean = km_digits
            km_rinvio = None
        elif not km_rinvio and not km_registrati:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Inserisci i km del veicolo, oppure spiega perché li metti alla fine. "
                    "Se non vedi il campo, ricarica la pagina."
                ),
            )
    elif body.type == "COMPLETE":
        if not km_registrati:
            if not km_valido:
                raise HTTPException(status_code=400, detail="Inserisci i km del veicolo per completare il lavoro")
            km_clean = km_digits
        km_rinvio = None
        # Le ore in fattura le conferma il meccanico: i timbri da soli non bastano
        # (restano aperti, o il lavoro è iniziato prima della commessa).
        # Se le ha già confermate prima — dalla scheda ORE LAVORATE della commessa —
        # valgono quelle: si danno una volta sola, come i km.
        if body.minutes_effective is None and row.get("minutes_effective") is None:
            raise HTTPException(
                status_code=400,
                detail=("Conferma le ore lavorate per completare il lavoro. "
                        "Se non vedi il campo, ricarica la pagina."),
            )
        if body.minutes_effective is not None and not (0 <= body.minutes_effective <= 100000):
            raise HTTPException(status_code=400, detail="Ore non valide")
    elif body.type == "KM":
        # correzione di un chilometraggio sbagliato: numero + motivo, sempre
        if not km_valido:
            raise HTTPException(status_code=400, detail="Chilometraggio non valido")
        if not (body.reason or "").strip():
            raise HTTPException(status_code=400, detail="Scrivi il motivo della correzione dei km")
        km_clean = km_digits
        km_rinvio = None
    else:
        km_rinvio = None

    # La foto del libretto va salvata PRIMA di registrare l'evento: se il file non
    # è valido il lavoro non deve partire a metà.
    if body.type == "START" and (body.libretto_base64 or "").strip():
        await _salva_foto_base64(order_id, user, body.libretto_base64, kind="libretto")

    ai_note = (
        await _ai_interpret_reason(body.reason or "", body.type)
        if body.reason and body.type != "KM" else None
    )
    event_id = str(uuid.uuid4())
    ts = now_utc()

    await execute(
        """INSERT INTO work_events (id, work_order_id, worker_id, worker_username, worker_full_name, type, reason, photos_base64, timestamp, ai_interpretation, km, km_deferred_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)""",
        event_id, order_id, user["id"], user["username"], user["full_name"],
        body.type, body.reason, json.dumps(body.photos_base64), ts, ai_note, km_clean, km_rinvio
    )

    # I km finiscono anche nella scheda tecnica (l'AI e i report li usano da lì)
    if km_clean:
        scheda_raw["km"] = km_clean
        await execute(
            "UPDATE work_orders SET scheda_tecnica=$1::jsonb WHERE id=$2",
            json.dumps(SchedaTecnica(**scheda_raw).model_dump()), order_id
        )

    # L'olio messo nel motore: unico consumabile che il meccanico dichiara a mano,
    # perche' viene dal fusto dell'officina e non da nessuna bolla per commessa.
    if body.type == "COMPLETE" and body.olio_litri and body.olio_litri > 0:
        litri = round(float(body.olio_litri), 2)
        cons = [c for c in (scheda_raw.get("consumabili") or [])
                if isinstance(c, dict) and str(c.get("nome", "")).lower() != "olio motore"]
        cons.append({"nome": "Olio motore", "quantita": litri})
        scheda_raw["consumabili"] = cons
        await execute(
            "UPDATE work_orders SET scheda_tecnica=$1::jsonb WHERE id=$2",
            json.dumps(SchedaTecnica(**scheda_raw).model_dump()), order_id
        )

    # Ore confermate alla chiusura: sono quelle che Omnius porta in fattura
    if body.type == "COMPLETE" and body.minutes_effective is not None:
        await execute(
            "UPDATE work_orders SET minutes_effective=$1, minutes_effective_reason=$2 WHERE id=$3",
            body.minutes_effective, "confermate dal meccanico alla chiusura", order_id
        )

    # La correzione dei km non tocca lo stato della commessa
    new_status_map = {"START": "in_progress", "RESUME": "in_progress", "PAUSE": "paused", "COMPLETE": "completed"}
    if body.type in new_status_map:
        await execute(
            "UPDATE work_orders SET status=$1, updated_at=$2 WHERE id=$3",
            new_status_map[body.type], now_utc(), order_id
        )
    else:
        await execute("UPDATE work_orders SET updated_at=$1 WHERE id=$2", now_utc(), order_id)

    # A lavoro completato, il caso entra nella memoria storica dell'officina (in background)
    if body.type == "COMPLETE":
        asyncio.create_task(_upsert_case_embedding(order_id))
        # ...e il titolare va avvisato subito: deve poter preparare la fattura
        asyncio.create_task(_avvisa_lavoro_completato(order_id, user["full_name"] or user["username"]))

    return WorkEvent(
        id=event_id, work_order_id=order_id, worker_id=user["id"],
        worker_username=user["username"], worker_full_name=user["full_name"],
        type=body.type, reason=body.reason, photos_base64=body.photos_base64,
        timestamp=ts, ai_interpretation=ai_note, km=km_clean, km_deferred_reason=km_rinvio
    )


@api.get("/work-orders/{order_id}/events", response_model=List[WorkEvent])
async def list_events(order_id: str, user: dict = Depends(get_current_user)):
    row = await fetchrow("SELECT assigned_worker_ids FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    if user["role"] == "worker" and user["id"] not in worker_ids:
        raise HTTPException(status_code=403, detail="Non assegnato")
    rows = await fetch(
        "SELECT * FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC LIMIT 1000",
        order_id
    )
    return [row_to_event(r) for r in rows]


@api.get("/events/recent", response_model=List[WorkEvent])
async def recent_events(limit: int = 50, admin: dict = Depends(require_admin)):
    rows = await fetch(f"SELECT * FROM work_events ORDER BY timestamp DESC LIMIT {min(limit, 200)}")
    return [row_to_event(r) for r in rows]


# ---- Live status ----
@api.get("/workers/live-status", response_model=List[LiveWorkerStatus])
async def workers_live_status(admin: dict = Depends(require_admin)):
    workers = await fetch("SELECT id, username, full_name FROM users WHERE role='worker' LIMIT 500")
    result: List[LiveWorkerStatus] = []
    now = now_utc()
    for w in workers:
        # le correzioni dei km non sono un cambio di stato: non devono far
        # risultare "in pausa" un operaio che sta lavorando
        last = await fetchrow(
            "SELECT * FROM work_events WHERE worker_id=$1 AND type <> 'KM' ORDER BY timestamp DESC LIMIT 1",
            w["id"]
        )
        if not last or last["type"] == "COMPLETE":
            result.append(LiveWorkerStatus(
                worker_id=w["id"], username=w["username"], full_name=w["full_name"],
                current_status="idle",
            ))
            continue
        status_str = "working" if last["type"] in ("START", "RESUME") else "paused"
        order = await fetchrow("SELECT plate, vehicle FROM work_orders WHERE id=$1", last["work_order_id"])
        label = f"{order['plate']} - {order['vehicle']}" if order else None
        ts = last["timestamp"]
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        minutes = int((now - ts).total_seconds() // 60)
        result.append(LiveWorkerStatus(
            worker_id=w["id"], username=w["username"], full_name=w["full_name"],
            current_status=status_str,
            current_work_order_id=last["work_order_id"],
            current_work_order_label=label,
            since=ts,
            minutes_since=minutes,
            last_reason=last.get("reason"),
        ))
    return result


# ---- AI Reports ----
def _parse_iso_date(s: Optional[str]) -> datetime:
    if not s:
        n = now_utc()
        return datetime(n.year, n.month, n.day, tzinfo=timezone.utc)
    try:
        d = datetime.strptime(s, "%Y-%m-%d")
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    except Exception:
        raise HTTPException(status_code=400, detail="Formato data non valido (usa YYYY-MM-DD)")


def _worker_minutes(events: list) -> int:
    total = 0
    open_at: Optional[datetime] = None
    for e in events:
        ts = e["timestamp"]
        if isinstance(ts, datetime) and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        t = e["type"]
        if t in ("START", "RESUME"):
            if open_at is None:
                open_at = ts
        elif t in ("PAUSE", "COMPLETE"):
            if open_at is not None:
                total += max(0, int((ts - open_at).total_seconds() // 60))
                open_at = None
    return total


class StatsWorker(BaseModel):
    full_name: str
    minutes_worked: int
    orders_touched: int
    completed: int


class StatsOut(BaseModel):
    days: int
    total_minutes: int
    orders_completed: int
    orders_created: int
    workers: List[StatsWorker]
    returning_vehicles: List[dict]   # {plate, vehicle, visits}
    top_lavori: List[dict]           # {lavoro, volte}


@api.get("/stats/overview", response_model=StatsOut)
async def stats_overview(days: int = 30, admin: dict = Depends(require_admin)):
    days = max(1, min(days, 365))
    since = now_utc() - timedelta(days=days)

    events = await fetch(
        "SELECT * FROM work_events WHERE timestamp >= $1 ORDER BY timestamp ASC LIMIT 20000", since
    )
    orders_created = await fetchrow(
        "SELECT count(*) AS c FROM work_orders WHERE created_at >= $1", since
    )
    completed_rows = await fetch(
        """SELECT DISTINCT work_order_id FROM work_events
           WHERE type='COMPLETE' AND timestamp >= $1""", since
    )

    # ore e commesse per operaio
    per_worker: dict = {}
    for e in events:
        w = per_worker.setdefault(e["worker_full_name"], {"events": [], "orders": set(), "completed": 0})
        w["events"].append(e)
        w["orders"].add(e["work_order_id"])
        if e["type"] == "COMPLETE":
            w["completed"] += 1
    workers = sorted(
        [StatsWorker(full_name=name, minutes_worked=_worker_minutes(d["events"]),
                     orders_touched=len(d["orders"]), completed=d["completed"])
         for name, d in per_worker.items()],
        key=lambda x: x.minutes_worked, reverse=True,
    )
    total_minutes = sum(w.minutes_worked for w in workers)

    # veicoli che tornano (tutto lo storico, targhe vere)
    ret_rows = await fetch(
        """SELECT UPPER(REPLACE(plate,' ','')) AS p, count(*) AS visits, max(vehicle) AS vehicle
           FROM work_orders
           WHERE UPPER(REPLACE(plate,' ','')) NOT IN ('DAINSERIRE','')
           GROUP BY 1 HAVING count(*) > 1 ORDER BY visits DESC LIMIT 10"""
    )
    returning = [{"plate": r["p"], "vehicle": r["vehicle"], "visits": r["visits"]} for r in ret_rows]

    # lavori più frequenti (voci di lavori_fatti nel periodo)
    order_rows = await fetch(
        "SELECT scheda_tecnica FROM work_orders WHERE updated_at >= $1 LIMIT 2000", since
    )
    conteggio: dict = {}
    for r in order_rows:
        scheda = r.get("scheda_tecnica") or {}
        if isinstance(scheda, str):
            scheda = json.loads(scheda)
        for lav in (scheda.get("lavori_fatti") or []):
            key = lav.strip().lower()
            if len(key) > 2:
                conteggio[key] = conteggio.get(key, 0) + 1
    top_lavori = [{"lavoro": k, "volte": v} for k, v in
                  sorted(conteggio.items(), key=lambda kv: kv[1], reverse=True)[:10]]

    return StatsOut(
        days=days, total_minutes=total_minutes,
        orders_completed=len(completed_rows), orders_created=orders_created["c"],
        workers=workers, returning_vehicles=returning, top_lavori=top_lavori,
    )


# ---- Chiedi all'AI (domande libere del titolare sui dati veri) ----
def _totali_per_operaio(events: List[dict], days: int) -> str:
    """I TOTALI li calcola il registro, non il modello.

    Prima passavamo solo l'elenco delle commesse e l'AI doveva sommare a mano 136
    righe: due domande identiche davano due risposte diverse, e nessuna delle due
    era giusta (Luciano risultava 19 o 20 macchine invece di 44). Sommare righe di
    testo è la cosa che un modello linguistico sbaglia più facilmente. Qui i conti
    sono già fatti: all'AI resta il mestiere suo, spiegarli."""
    per: dict = {}
    for e in events:
        per.setdefault(e["worker_full_name"], {}).setdefault(e["work_order_id"], []).append(dict(e))

    righe = []
    for nome, ordini in sorted(per.items()):
        completate = sum(1 for evs in ordini.values() if any(x["type"] == "COMPLETE" for x in evs))
        minuti = sum(_worker_minutes(evs) for evs in ordini.values())
        media = round(minuti / completate) if completate else 0
        righe.append(
            f"  {nome}: commesse COMPLETATE={completate} | commesse toccate={len(ordini)} | "
            f"minuti lavorati={minuti} ({round(minuti / 60, 1)} ore) | media per commessa completata={media} min"
        )
    if not righe:
        return ""
    return (
        f"\nTOTALI GIÀ CALCOLATI DAL REGISTRO — ULTIMI {days} GIORNI "
        "(cifre esatte: USA QUESTE, non rifare le somme riga per riga):\n"
        + "\n".join(righe) + "\n"
    )


async def _build_admin_digest(days: int = 60) -> str:
    """Digest compatto del registro officina per l'AI: totali già calcolati in cima,
    poi il dettaglio commessa per commessa."""
    since = now_utc() - timedelta(days=days)
    oggi = now_utc().strftime("%Y-%m-%d")
    orders = await fetch(
        "SELECT * FROM work_orders WHERE updated_at >= $1 ORDER BY created_at DESC LIMIT 300", since
    )
    events = await fetch(
        "SELECT * FROM work_events WHERE timestamp >= $1 ORDER BY timestamp ASC LIMIT 5000", since
    )
    ev_by_order: dict = {}
    for e in events:
        ev_by_order.setdefault(e["work_order_id"], []).append(e)

    order_ids = [o["id"] for o in orders]
    # Dialogo AI, messaggi in chat e didascalie foto: cosa è stato DETTO e VISTO (non solo scritto in scheda)
    dlg_by_order: dict = {}
    msg_by_order: dict = {}
    cap_by_order: dict = {}
    if order_ids:
        for c in await fetch("SELECT work_order_id, turns FROM conversations WHERE work_order_id = ANY($1)", order_ids):
            turns = c["turns"]
            if isinstance(turns, str):
                turns = json.loads(turns)
            said = [(t.get("text") or "").strip() for t in (turns or []) if t.get("role") == "user" and (t.get("text") or "").strip()]
            if said:
                dlg_by_order[c["work_order_id"]] = said
        for m in await fetch("SELECT work_order_id, sender_name, text FROM order_messages WHERE work_order_id = ANY($1) ORDER BY created_at ASC", order_ids):
            msg_by_order.setdefault(m["work_order_id"], []).append(f"{m['sender_name']}: {(m['text'] or '').strip()}")
        for p in await fetch("SELECT work_order_id, caption FROM order_photos WHERE work_order_id = ANY($1) AND caption IS NOT NULL", order_ids):
            cap_by_order.setdefault(p["work_order_id"], []).append((p["caption"] or "").strip())

    intestazione = (f"OGGI: {oggi}. REGISTRO ULTIMI {days} GIORNI "
                    f"({len(orders)} commesse, {len(events)} eventi):"
                    + _totali_per_operaio([dict(e) for e in events], days))
    lines = [intestazione]
    for o in orders:
        evs = ev_by_order.get(o["id"], [])
        per_worker: dict = {}
        for e in evs:
            per_worker.setdefault(e["worker_full_name"], []).append(e)
        scheda = o.get("scheda_tecnica") or {}
        if isinstance(scheda, str):
            scheda = json.loads(scheda)
        fatti = scheda.get("lavori_fatti") or []
        da_fare = scheda.get("lavori_da_fare") or []
        ricambi_cambiati = scheda.get("ricambi_sostituiti") or []
        nota_scheda = (scheda.get("note") or "").strip()
        # note ed esiti timbrati dagli operai (motivo pausa/interruzione, esito completamento)
        note_ev = []
        for e in evs:
            r = (e.get("reason") or "").strip() or (e.get("ai_interpretation") or "").strip()
            if r:
                note_ev.append(f"{e['type']}={r}")
        parts = [
            f"targa={o['plate']}", f"veicolo={o['vehicle']}", f"cliente={o['customer']}",
            f"stato={o['status']}", f"richiesta_iniziale={o['description'][:60]}",
            f"creata={o['created_at'].strftime('%Y-%m-%d')}",
        ]
        if fatti:
            parts.append("LAVORI_FATTI=" + "; ".join(fatti))
        if da_fare:
            parts.append("NON_fatti=" + "; ".join(da_fare))
        if ricambi_cambiati:
            parts.append("RICAMBI_CAMBIATI=" + "; ".join(ricambi_cambiati))
        if nota_scheda:
            parts.append("NOTA_scheda=" + nota_scheda[:220])
        if note_ev:
            parts.append("note_operaio=" + " || ".join(note_ev))
        dlg = dlg_by_order.get(o["id"])
        if dlg:
            parts.append("DIALOGO=" + (" || ".join(dlg))[:700])
        msgs = msg_by_order.get(o["id"])
        if msgs:
            parts.append("CHAT=" + (" || ".join(msgs))[:500])
        caps = cap_by_order.get(o["id"])
        if caps:
            parts.append("FOTO=" + ("; ".join(caps))[:500])
        for w, wevs in per_worker.items():
            mins = _worker_minutes(wevs)
            completata = any(e["type"] == "COMPLETE" for e in wevs)
            comp_date = next((e["timestamp"].strftime("%Y-%m-%d") for e in reversed(wevs) if e["type"] == "COMPLETE"), None)
            parts.append(f"operaio={w}({mins}min{', COMPLETATA il ' + comp_date if completata else ''})")
        lines.append(" | ".join(parts))

    # Il tetto serve a non sforare il contesto del modello. Ma i TOTALI non si
    # toccano mai: si tagliano i dettagli delle commesse più vecchie, e si scrive
    # quante ne restano fuori — un troncamento silenzioso sembra "ho visto tutto".
    TETTO = 48000
    testa = lines[0]
    dettagli = lines[1:]
    fuori = 0
    while dettagli and len(testa) + sum(len(x) + 1 for x in dettagli) > TETTO:
        dettagli.pop()
        fuori += 1
    if fuori:
        dettagli.append(
            f"[…{fuori} commesse più vecchie non elencate qui per ragioni di spazio: "
            f"i TOTALI in cima le comprendono comunque tutte.]"
        )
    return "\n".join([testa] + dettagli)


class AskIn(BaseModel):
    question: str
    history: List[dict] = Field(default_factory=list)  # [{role, text}] ultimi turni, per i follow-up


class AskOut(BaseModel):
    answer: str


@api.post("/admin/ask", response_model=AskOut)
async def admin_ask(body: AskIn, admin: dict = Depends(require_admin)):
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Domanda vuota")
    digest = await _build_admin_digest()
    messages = [{"role": "system", "content": ai.SYSTEM_ADMIN_ASK}]
    for t in body.history[-6:]:
        role = "user" if t.get("role") == "user" else "assistant"
        messages.append({"role": role, "content": str(t.get("text", ""))[:1000]})
    messages.append({"role": "user", "content": f"{digest}\n\nDOMANDA DEL TITOLARE: {question}"})
    try:
        answer = await ai.chat(messages, max_tokens=700)
    except Exception as e:
        msg = str(e)
        status_code = 429 if "429" in msg or "rate" in msg.lower() else 500
        logger.exception("admin ask failed")
        raise HTTPException(status_code=status_code, detail=f"AI non disponibile: {e}")
    return AskOut(answer=answer.strip())


@api.get("/reports/daily", response_model=DailyReportOut)
async def daily_report(
    worker_ids: Optional[str] = None,
    date: Optional[str] = None,
    date_to: Optional[str] = None,
    admin: dict = Depends(require_admin),
):
    day_start = _parse_iso_date(date)
    # date_to (incluso) permette report su periodi: settimana, mese, intervallo libero
    range_end = _parse_iso_date(date_to) if date_to else day_start
    if range_end < day_start:
        day_start, range_end = range_end, day_start
    if (range_end - day_start).days > 366:
        raise HTTPException(status_code=400, detail="Periodo troppo lungo (max 1 anno)")
    day_end = range_end + timedelta(days=1)
    filter_ids = [w for w in (worker_ids.split(",") if worker_ids else []) if w.strip()]

    if filter_ids:
        workers = await fetch(
            "SELECT id, username, full_name FROM users WHERE role='worker' AND id=ANY($1) LIMIT 500",
            filter_ids
        )
        events = await fetch(
            "SELECT * FROM work_events WHERE timestamp>=$1 AND timestamp<$2 AND worker_id=ANY($3) AND type <> 'KM' ORDER BY timestamp ASC LIMIT 5000",
            day_start, day_end, filter_ids
        )
    else:
        workers = await fetch("SELECT id, username, full_name FROM users WHERE role='worker' LIMIT 500")
        events = await fetch(
            "SELECT * FROM work_events WHERE timestamp>=$1 AND timestamp<$2 AND type <> 'KM' ORDER BY timestamp ASC LIMIT 5000",
            day_start, day_end
        )

    workers_map = {w["id"]: w for w in workers}
    per_worker: dict = {w["id"]: {"events": [], "orders": {}} for w in workers}
    for e in events:
        wid = e["worker_id"]
        if wid not in per_worker:
            if filter_ids:
                continue
            per_worker[wid] = {"events": [], "orders": {}}
            workers_map[wid] = {"id": wid, "username": e.get("worker_username", "?"), "full_name": e.get("worker_full_name", "?")}
        per_worker[wid]["events"].append(e)
        oid = e["work_order_id"]
        per_worker[wid]["orders"].setdefault(oid, []).append(e)

    all_oids = list({e["work_order_id"] for e in events})
    orders_map: dict = {}
    if all_oids:
        order_rows = await fetch("SELECT * FROM work_orders WHERE id=ANY($1)", all_oids)
        for o in order_rows:
            orders_map[o["id"]] = o

    workers_stats: List[WorkerDailyStats] = []
    total_events = 0
    total_minutes = 0
    for wid, data in per_worker.items():
        w = workers_map.get(wid) or {"id": wid, "username": "?", "full_name": "?"}
        w_events = data["events"]
        w_minutes = _worker_minutes(w_events)
        total_events += len(w_events)
        total_minutes += w_minutes
        orders_stats: List[WorkerOrderStats] = []
        for oid, evs in data["orders"].items():
            o = orders_map.get(oid) or {"plate": "?", "vehicle": "?", "customer": "?"}
            orders_stats.append(WorkerOrderStats(
                order_id=oid, plate=o.get("plate", "?"), vehicle=o.get("vehicle", "?"), customer=o.get("customer", "?"),
                events_count=len(evs), minutes_worked=_worker_minutes(evs),
                started_at=evs[0]["timestamp"], last_event_at=evs[-1]["timestamp"],
            ))
        orders_stats.sort(key=lambda x: x.last_event_at or day_start, reverse=True)
        workers_stats.append(WorkerDailyStats(
            worker_id=wid, username=w.get("username", "?"), full_name=w.get("full_name", "?"),
            events_count=len(w_events), minutes_worked=w_minutes, orders=orders_stats,
        ))
    workers_stats.sort(key=lambda x: x.minutes_worked, reverse=True)

    orders_touched = len(all_oids)
    date_str = day_start.strftime("%Y-%m-%d")
    if range_end != day_start:
        date_str = f"{date_str} → {range_end.strftime('%Y-%m-%d')}"

    if not events:
        narrative = "Nessuna attività registrata per il periodo/filtro selezionato."
    else:
        summary_lines = []
        for e in events:
            ts = e["timestamp"]
            t = ts.strftime("%H:%M") if isinstance(ts, datetime) else str(ts)
            reason = f" — {e['reason']}" if e.get("reason") else ""
            o = orders_map.get(e["work_order_id"], {})
            plate = o.get("plate", "?")
            summary_lines.append(f"[{t}] {e['worker_full_name']} su {plate}: {e['type']}{reason}")
        events_text = "\n".join(summary_lines)
        selection_hint = (
            f"Meccanici selezionati: {', '.join(w['full_name'] for w in workers)}"
            if filter_ids and workers else "Tutti i meccanici"
        )
        try:
            narrative = (await ai.chat(
                [
                    {"role": "system", "content": ai.SYSTEM_DAILY_REPORT},
                    {"role": "user", "content": (
                        f"Periodo: {date_str}\n{selection_hint}\n\n"
                        f"Statistiche aggregate: {total_events} eventi, {total_minutes} minuti, {orders_touched} commesse.\n\n"
                        f"Timeline eventi:\n{events_text}"
                    )},
                ],
                max_tokens=1800,
            )).strip()
        except Exception as e:
            logger.warning(f"Daily narrative failed: {e}")
            narrative = f"Errore AI: {e}\n\nEventi grezzi:\n{events_text}"

    return DailyReportOut(
        date=date_str, filter_worker_ids=filter_ids, workers=workers_stats,
        total_events=total_events, total_minutes=total_minutes,
        orders_touched=orders_touched, narrative=narrative, generated_at=now_utc(),
    )


# ---- Vision: plate OCR ----
PLATE_RE = re.compile(r"[A-Z]{2}\s?[0-9]{3}\s?[A-Z]{2}")


@api.post("/vision/plate", response_model=PlateOcrOut)
async def ocr_plate(body: PlateOcrIn, user: dict = Depends(get_current_user)):
    b64 = body.image_base64
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    data_url = f"data:image/jpeg;base64,{b64}"
    try:
        pages_text = await ai.ocr_image(data_url)
        raw = pages_text.strip().upper()
        m = PLATE_RE.search(raw.replace("-", "").replace(".", "").replace("\n", " "))
        plate = m.group(0).replace(" ", "") if m else None
        return PlateOcrOut(plate=plate, raw=(raw[:200] if raw else "NON_TROVATA"))
    except Exception as e:
        logger.warning(f"plate ocr soft-fail: {e}")
        return PlateOcrOut(plate=None, raw="NON_TROVATA")


# ---- Dati veicolo dalla targa (via STAR/Omnius, coda di richieste) ----
async def _append_ai_turn(order_id: str, text: str) -> None:
    """Aggiunge un turno 'assistant' alla conversazione della commessa."""
    now = now_utc()
    convo_row = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
    turns_raw = convo_row["turns"] if convo_row else []
    if isinstance(turns_raw, str):
        turns_raw = json.loads(turns_raw)
    new_turns = (turns_raw or []) + [{"role": "assistant", "text": text, "timestamp": now.isoformat()}]
    await execute(
        """INSERT INTO conversations (work_order_id, turns, created_at, updated_at)
           VALUES ($1, $2::jsonb, $3, $3)
           ON CONFLICT (work_order_id) DO UPDATE SET turns=$2::jsonb, updated_at=$3""",
        order_id, json.dumps(new_turns), now
    )


async def _apply_vehicle_data(order_id: str, plate: str, *, marca: Optional[str], modello: Optional[str],
                              anno: Optional[str], motore: Optional[str], vin: Optional[str],
                              note_extra: Optional[str], source: str) -> SchedaTecnica:
    """Scrive i dati veicolo nella scheda tecnica e annota la provenienza in conversazione."""
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    merged = dict(scheda_raw)
    if marca:
        merged["marca"] = marca
    if modello:
        merged["modello"] = modello
    if anno:
        merged["anno"] = str(anno)
    if motore:
        merged["motore"] = motore
    if note_extra:
        prev = (merged.get("note") or "").strip()
        if note_extra not in prev:
            merged["note"] = f"{prev}\n{note_extra}".strip()
    scheda_final = SchedaTecnica(**merged)
    now = now_utc()
    parts = ["UPDATE work_orders SET scheda_tecnica=$1::jsonb, updated_at=$2"]
    vals: list = [json.dumps(scheda_final.model_dump()), now]
    if vin:
        parts.append(", vin=$3")
        vals.append(vin)
    vals.append(order_id)
    await execute(f"{''.join(parts)} WHERE id=${len(vals)}", *vals)
    await _append_ai_turn(order_id, f"Targa {plate}: {merged.get('marca','')} {merged.get('modello','')} — dati da {source}.")
    return scheda_final


class PlateLookupIn(BaseModel):
    plate: Optional[str] = None  # se assente, usa la targa già salvata sulla commessa


class PlateLookupQueuedOut(BaseModel):
    queued: bool
    request_id: Optional[str] = None
    message: str


@api.post("/work-orders/{order_id}/lookup-plate", response_model=PlateLookupQueuedOut)
async def lookup_plate(order_id: str, body: PlateLookupIn = PlateLookupIn(), user: dict = Depends(get_current_user)):
    """Mette in coda la richiesta dati veicolo: il fattorino di Omnius la ritira,
    interroga l'anagrafica STAR e riporta la risposta su /v1/omnius/lookup-results."""
    if not OMNIUS_KEY:
        raise HTTPException(status_code=503, detail="Integrazione STAR non configurata")
    await _order_or_403(order_id, user)
    row = await fetchrow("SELECT plate FROM work_orders WHERE id=$1", order_id)
    plate = (body.plate or row.get("plate") or "").strip().upper().replace(" ", "")
    if not plate:
        raise HTTPException(status_code=400, detail="Nessuna targa disponibile")

    # dedupe: una sola richiesta pendente per commessa+targa
    existing = await fetchrow(
        "SELECT id FROM plate_lookup_requests WHERE work_order_id=$1 AND plate=$2 AND status='pending'",
        order_id, plate
    )
    if existing:
        return PlateLookupQueuedOut(queued=True, request_id=existing["id"],
                                    message="Richiesta già in coda, dati in arrivo da STAR")
    req_id = str(uuid.uuid4())
    await execute(
        """INSERT INTO plate_lookup_requests (id, work_order_id, plate, status, requested_by_name, created_at)
           VALUES ($1,$2,$3,'pending',$4,$5)""",
        req_id, order_id, plate, user["full_name"], now_utc()
    )
    return PlateLookupQueuedOut(queued=True, request_id=req_id, message="Richiesta inviata, dati in arrivo da STAR")


class OmniusLookupRequestOut(BaseModel):
    request_id: str
    work_order_id: str
    plate: str
    created_at: datetime


@api.get("/v1/omnius/lookup-requests", response_model=List[OmniusLookupRequestOut], dependencies=[Depends(require_omnius_key)])
async def omnius_lookup_requests():
    """Le richieste targa in attesa. Il fattorino le ritira, chiede a STAR e risponde su lookup-results."""
    rows = await fetch(
        "SELECT id, work_order_id, plate, created_at FROM plate_lookup_requests WHERE status='pending' ORDER BY created_at ASC LIMIT 50"
    )
    return [OmniusLookupRequestOut(request_id=r["id"], work_order_id=r["work_order_id"],
                                   plate=r["plate"], created_at=r["created_at"]) for r in rows]


class OmniusLookupResultIn(BaseModel):
    request_id: str
    found: bool
    make: Optional[str] = None
    model: Optional[str] = None
    year: Optional[str] = None
    engine: Optional[str] = None       # descrizione libera es. "1.3 Multijet 1248cc Diesel 95CV"
    vin: Optional[str] = None
    customer: Optional[str] = None     # se STAR ha l'anagrafica
    note: Optional[str] = None         # extra (versione, allestimento...)


@api.post("/v1/omnius/lookup-results", dependencies=[Depends(require_omnius_key)])
async def omnius_lookup_result(body: OmniusLookupResultIn):
    req = await fetchrow("SELECT * FROM plate_lookup_requests WHERE id=$1", body.request_id)
    if not req:
        # Una richiesta sconosciuta NON e' un errore da riprovare: e' gia' stata evasa e
        # ripulita, oppure Omnius ha in coda un id vecchio. Rispondendo 404 il postino la
        # considerava fallita e la ripresentava all'infinito — 1.761 chiamate in tre ore.
        logger.info(f"lookup-results: richiesta {body.request_id} sconosciuta, la archivio")
        return {"ok": True, "note": "richiesta sconosciuta o già archiviata: non ripresentarla"}
    if req["status"] != "pending":
        return {"ok": True, "note": "richiesta già evasa"}
    order_id, plate = req["work_order_id"], req["plate"]

    # La commessa puo' essere stata cancellata dopo la richiesta: la risposta non ha piu'
    # dove andare. Va chiusa qui, altrimenti il postino la ripresenta all'infinito — due
    # richieste del 30 luglio hanno prodotto 1.761 chiamate in tre ore.
    if not await fetchrow("SELECT id FROM work_orders WHERE id=$1", order_id):
        await execute(
            "UPDATE plate_lookup_requests SET status='failed', answered_at=$1 WHERE id=$2",
            now_utc(), body.request_id)
        logger.info(f"lookup-results: commessa di {plate} cancellata, richiesta archiviata")
        return {"ok": True, "note": "commessa non esiste più: richiesta archiviata, non ripresentarla"}

    if not body.found:
        await execute("UPDATE plate_lookup_requests SET status='failed', answered_at=$1 WHERE id=$2", now_utc(), body.request_id)
        await _append_ai_turn(order_id, f"Targa {plate}: dati non trovati in STAR. Compila la scheda a voce o a mano.")
        return {"ok": True, "found": False}

    await _apply_vehicle_data(
        order_id, plate,
        marca=body.make, modello=body.model, anno=body.year, motore=body.engine,
        vin=body.vin, note_extra=body.note, source="STAR",
    )
    # aggiorna cliente e veicolo se STAR li conosce e da noi sono segnaposto
    row = await fetchrow("SELECT customer, vehicle FROM work_orders WHERE id=$1", order_id)
    if row:
        if body.customer and body.customer.strip() and \
           (row["customer"] or "").strip().upper() in PLACEHOLDER_CLIENTE:
            await execute("UPDATE work_orders SET customer=$1, updated_at=$2 WHERE id=$3",
                          body.customer.strip(), now_utc(), order_id)
        vehicle_label = " ".join(filter(None, [body.make, body.model, body.year and f"({body.year})"]))
        if vehicle_label and (row["vehicle"] or "").strip().upper() in PLACEHOLDER_VEICOLO:
            await execute("UPDATE work_orders SET vehicle=$1, updated_at=$2 WHERE id=$3",
                          vehicle_label, now_utc(), order_id)
    await execute("UPDATE plate_lookup_requests SET status='answered', answered_at=$1 WHERE id=$2", now_utc(), body.request_id)
    return {"ok": True, "found": True}


# ---- Audio: transcription ----
@api.post("/audio/transcribe", response_model=TranscribeOut)
async def transcribe_audio(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    data = await file.read()
    filename = file.filename or "audio.m4a"
    try:
        text = await ai.transcribe(data, filename)
        return TranscribeOut(text=text)
    except Exception as e:
        logger.exception("transcribe failed")
        raise HTTPException(status_code=500, detail=f"Trascrizione fallita: {e}")


# ---- AI Voice Chat ----
def _extract_json_block(s: str) -> Optional[dict]:
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", s, re.DOTALL)
    if not m:
        m = re.search(r"(\{.*\})", s, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


# ---- Memoria storica dell'officina (RAG su pgvector) ----
def _vec_literal(vec: List[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


async def _embed_text(text: str) -> Optional[str]:
    """Testo -> literal vettore pgvector. None se l'API fallisce (soft-fail)."""
    try:
        vecs = await ai.embed([text[:20000]])
        return _vec_literal(vecs[0])
    except Exception as e:
        logger.warning(f"embedding fallito: {e}")
        return None


def _build_case_content(row: dict, events: List[dict], turns: List[dict], messages: Optional[List[dict]] = None) -> str:
    """Costruisce il 'caso' testuale di una commessa: veicolo, problema, lavori, ricambi, dialogo."""
    scheda = row.get("scheda_tecnica") or {}
    if isinstance(scheda, str):
        scheda = json.loads(scheda)
    parts = [
        f"VEICOLO: {row.get('vehicle', '')} — targa {row.get('plate', '')}",
    ]
    for label, key in (("MARCA", "marca"), ("MODELLO", "modello"), ("ANNO", "anno"), ("MOTORE", "motore"), ("KM", "km")):
        if scheda.get(key):
            parts.append(f"{label}: {scheda[key]}")
    if row.get("description"):
        parts.append(f"PROBLEMA/LAVORAZIONE: {row['description']}")
    if scheda.get("lavori_fatti"):
        parts.append("LAVORI FATTI: " + "; ".join(scheda["lavori_fatti"]))
    if scheda.get("lavori_da_fare"):
        parts.append("LAVORI RIMASTI: " + "; ".join(scheda["lavori_da_fare"]))
    if scheda.get("ricambi_necessari"):
        parts.append("RICAMBI: " + "; ".join(scheda["ricambi_necessari"]))
    if scheda.get("note"):
        parts.append(f"NOTE: {scheda['note']}")
    complete_reasons = [e.get("reason") for e in events if e.get("type") == "COMPLETE" and e.get("reason")]
    if complete_reasons:
        parts.append("ESITO: " + " | ".join(complete_reasons))
    # Anche le note di INIZIA/PAUSA/RIPRENDI raccontano il lavoro: entrano nel caso
    altre_note = [f"{e.get('type')}: {e.get('reason')}" for e in events
                  if e.get("type") != "COMPLETE" and e.get("reason")]
    if altre_note:
        parts.append("NOTE EVENTI: " + " | ".join(altre_note)[:800])
    dialog = " / ".join(t.get("text", "") for t in turns if t.get("role") == "user")
    if dialog:
        parts.append(f"DIALOGO OPERAIO: {dialog[:1500]}")
    if messages:
        # Gli scambi tra officina e operai contengono spesso la vera diagnosi:
        # entrano nel caso così l'AI impara anche dalle conversazioni.
        scambi = " / ".join(f"{m['sender_name']}: {m['text']}" for m in messages)
        parts.append(f"SCAMBI OFFICINA (messaggi): {scambi[:1500]}")
    return "\n".join(parts)[:7000]


async def _upsert_case_embedding(order_id: str):
    """Indicizza (o re-indicizza) una commessa completata nella memoria storica."""
    try:
        row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
        if not row:
            return
        events = await fetch("SELECT type, reason FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC", order_id)
        convo = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
        turns_raw = convo["turns"] if convo else []
        if isinstance(turns_raw, str):
            turns_raw = json.loads(turns_raw)
        messages = await fetch(
            "SELECT sender_name, text FROM order_messages WHERE work_order_id=$1 ORDER BY created_at ASC LIMIT 200",
            order_id
        )
        content = _build_case_content(row, events, turns_raw or [], messages)
        vec = await _embed_text(content)
        if not vec:
            return
        await execute(
            """INSERT INTO case_embeddings (work_order_id, content, embedding, updated_at)
               VALUES ($1, $2, $3::vector, $4)
               ON CONFLICT (work_order_id) DO UPDATE SET content=$2, embedding=$3::vector, updated_at=$4""",
            order_id, content, vec, now_utc()
        )
        logger.info(f"memoria storica: indicizzata commessa {order_id}")
    except Exception as e:
        logger.warning(f"memoria storica: indicizzazione fallita per {order_id}: {e}")


async def _backfill_case_embeddings():
    """All'avvio: indicizza le commesse completate che mancano dalla memoria storica."""
    try:
        await asyncio.sleep(5)  # lascia finire lo startup
        rows = await fetch(
            """SELECT w.id FROM work_orders w
               LEFT JOIN case_embeddings c ON c.work_order_id = w.id
               WHERE w.status='completed' AND c.work_order_id IS NULL LIMIT 200"""
        )
        for r in rows:
            await _upsert_case_embedding(r["id"])
            await asyncio.sleep(0.3)
        if rows:
            logger.info(f"memoria storica: backfill di {len(rows)} commesse completato")
    except Exception as e:
        logger.warning(f"memoria storica: backfill fallito: {e}")


async def _find_similar_cases(query_text: str, exclude_order_id: str, limit: int = 3) -> List[dict]:
    """Cerca nella memoria storica i casi più simili al problema attuale."""
    vec = await _embed_text(query_text)
    if not vec:
        return []
    try:
        rows = await fetch(
            """SELECT c.work_order_id, c.content, w.plate, w.vehicle,
                      1 - (c.embedding <=> $1::vector) AS similarity
               FROM case_embeddings c
               JOIN work_orders w ON w.id = c.work_order_id
               WHERE c.work_order_id != $2 AND w.status = 'completed'
               ORDER BY c.embedding <=> $1::vector
               LIMIT $3""",
            vec, exclude_order_id, limit
        )
        return [r for r in rows if r["similarity"] > 0.55]
    except Exception as e:
        logger.warning(f"memoria storica: ricerca fallita: {e}")
        return []


# ---- Archivio Tecnico (documentazione ufficiale dell'officina) ----
class KnowledgeDocOut(BaseModel):
    doc_id: str
    title: str
    chunks: int
    created_by_name: Optional[str] = None
    created_at: datetime


class KnowledgeAddIn(BaseModel):
    title: str
    content: str


def _chunk_text(text: str, max_len: int = 1200) -> List[str]:
    """Spezza il testo in blocchi ~max_len rispettando i paragrafi."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: List[str] = []
    current = ""
    for p in paragraphs:
        if len(current) + len(p) + 2 <= max_len:
            current = f"{current}\n\n{p}".strip()
        else:
            if current:
                chunks.append(current)
            # paragrafo singolo più lungo del limite: taglio duro
            while len(p) > max_len:
                chunks.append(p[:max_len])
                p = p[max_len:]
            current = p
    if current:
        chunks.append(current)
    return chunks


async def _embed_texts(texts: List[str]) -> Optional[List[str]]:
    """Più testi -> literal pgvector, in una sola chiamata API. None se fallisce."""
    try:
        vecs = await ai.embed([t[:20000] for t in texts])
        return [_vec_literal(v) for v in vecs]
    except Exception as e:
        logger.warning(f"embedding batch fallito: {e}")
        return None


async def _store_knowledge_doc(title: str, content: str, author: str) -> KnowledgeDocOut:
    chunks = _chunk_text(content)
    if not chunks:
        raise HTTPException(status_code=400, detail="Documento vuoto")
    if len(chunks) > 400:
        raise HTTPException(status_code=413, detail=f"Documento troppo grande ({len(chunks)} blocchi, max 400)")
    vecs = await _embed_texts(chunks)
    if not vecs:
        raise HTTPException(status_code=502, detail="Indicizzazione fallita (servizio AI non raggiungibile), riprova")
    doc_id = str(uuid.uuid4())
    now = now_utc()
    for i, (chunk, vec) in enumerate(zip(chunks, vecs)):
        await execute(
            """INSERT INTO knowledge_docs (id, doc_id, title, chunk_idx, content, embedding, created_by_name, created_at)
               VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8)""",
            str(uuid.uuid4()), doc_id, title, i, chunk, vec, author, now
        )
    logger.info(f"archivio tecnico: '{title}' indicizzato in {len(chunks)} blocchi")
    return KnowledgeDocOut(doc_id=doc_id, title=title, chunks=len(chunks), created_by_name=author, created_at=now)


async def _find_knowledge(query_text: str, limit: int = 3) -> List[dict]:
    """Cerca nell'Archivio Tecnico i blocchi più pertinenti alla domanda."""
    vec = await _embed_text(query_text)
    if not vec:
        return []
    try:
        rows = await fetch(
            """SELECT title, content, 1 - (embedding <=> $1::vector) AS similarity
               FROM knowledge_docs
               ORDER BY embedding <=> $1::vector
               LIMIT $2""",
            vec, limit
        )
        return [r for r in rows if r["similarity"] > 0.5]
    except Exception as e:
        logger.warning(f"archivio tecnico: ricerca fallita: {e}")
        return []


@api.post("/knowledge", response_model=KnowledgeDocOut)
async def add_knowledge(body: KnowledgeAddIn, admin: dict = Depends(require_admin)):
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Titolo obbligatorio")
    return await _store_knowledge_doc(title, body.content, admin["full_name"])


@api.post("/knowledge/upload", response_model=KnowledgeDocOut)
async def upload_knowledge_pdf(file: UploadFile = File(...), admin: dict = Depends(require_admin)):
    filename = file.filename or "documento.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Solo PDF. Per il testo usa 'Aggiungi testo'.")
    data = await file.read()
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF troppo grande (max 30MB)")
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF non leggibile: {e}")
    if not text.strip():
        raise HTTPException(status_code=400, detail="PDF senza testo estraibile (è una scansione? Serve un PDF testuale)")
    title = filename.rsplit(".", 1)[0]
    return await _store_knowledge_doc(title, text, admin["full_name"])


@api.get("/knowledge", response_model=List[KnowledgeDocOut])
async def list_knowledge(admin: dict = Depends(require_admin)):
    rows = await fetch(
        """SELECT doc_id, title, count(*) AS chunks, min(created_by_name) AS created_by_name, min(created_at) AS created_at
           FROM knowledge_docs GROUP BY doc_id, title ORDER BY min(created_at) DESC"""
    )
    return [KnowledgeDocOut(**dict(r)) for r in rows]


class KnowledgeDocFull(BaseModel):
    doc_id: str
    title: str
    content: str          # il testo intero, ricucito dai blocchi
    chunks: int
    created_by_name: Optional[str] = None
    created_at: datetime


@api.get("/knowledge/{doc_id}", response_model=KnowledgeDocFull)
async def read_knowledge(doc_id: str, admin: dict = Depends(require_admin)):
    """Rilegge un documento per intero. In archivio è spezzato in blocchi per la
    ricerca: qui si ricuce nell'ordine originale, così il titolare lo rilegge e
    lo corregge com'era."""
    rows = await fetch(
        "SELECT title, content, chunk_idx, created_by_name, created_at FROM knowledge_docs "
        "WHERE doc_id=$1 ORDER BY chunk_idx ASC", doc_id
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Documento non trovato")
    return KnowledgeDocFull(
        doc_id=doc_id, title=rows[0]["title"],
        content="\n\n".join(r["content"] for r in rows),
        chunks=len(rows), created_by_name=rows[0]["created_by_name"],
        created_at=rows[0]["created_at"],
    )


@api.put("/knowledge/{doc_id}", response_model=KnowledgeDocOut)
async def update_knowledge(doc_id: str, body: KnowledgeAddIn, admin: dict = Depends(require_admin)):
    """Correzione di un documento. Il testo cambia, quindi vanno rifatti anche i
    vettori: si reindicizza da capo e solo se la nuova versione è a posto si butta
    la vecchia — se l'indicizzazione fallisce, l'archivio resta com'era."""
    esiste = await fetchrow("SELECT created_by_name, created_at FROM knowledge_docs WHERE doc_id=$1", doc_id)
    if not esiste:
        raise HTTPException(status_code=404, detail="Documento non trovato")
    titolo = (body.title or "").strip()
    testo = (body.content or "").strip()
    if not titolo:
        raise HTTPException(status_code=400, detail="Titolo obbligatorio")
    if not testo:
        raise HTTPException(status_code=400, detail="Testo obbligatorio")

    chunks = _chunk_text(testo)
    if not chunks:
        raise HTTPException(status_code=400, detail="Documento vuoto")
    if len(chunks) > 400:
        raise HTTPException(status_code=413, detail=f"Documento troppo grande ({len(chunks)} blocchi, max 400)")
    vecs = await _embed_texts(chunks)
    if not vecs:
        raise HTTPException(status_code=502, detail="Indicizzazione fallita (servizio AI non raggiungibile), riprova")

    now = now_utc()
    autore = esiste["created_by_name"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM knowledge_docs WHERE doc_id=$1", doc_id)
            for i, (chunk, vec) in enumerate(zip(chunks, vecs)):
                await conn.execute(
                    """INSERT INTO knowledge_docs (id, doc_id, title, chunk_idx, content, embedding, created_by_name, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8)""",
                    str(uuid.uuid4()), doc_id, titolo, i, chunk, vec, autore, now
                )
    logger.info(f"archivio tecnico: '{titolo}' corretto e reindicizzato in {len(chunks)} blocchi")
    return KnowledgeDocOut(doc_id=doc_id, title=titolo, chunks=len(chunks),
                           created_by_name=autore, created_at=now)


@api.delete("/knowledge/{doc_id}")
async def delete_knowledge(doc_id: str, admin: dict = Depends(require_admin)):
    async with pool.acquire() as conn:
        res = await conn.execute("DELETE FROM knowledge_docs WHERE doc_id=$1", doc_id)
    if res == "DELETE 0":
        raise HTTPException(status_code=404, detail="Documento non trovato")
    return {"ok": True}


@api.post("/work-orders/{order_id}/voice-turn", response_model=VoiceTurnOut)
async def voice_turn(order_id: str, body: VoiceTurnIn, user: dict = Depends(get_current_user)):
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    if user["role"] == "worker" and user["id"] not in worker_ids:
        raise HTTPException(status_code=403, detail="Non assegnato a questa commessa")

    user_text = body.user_text.strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Testo vuoto")

    convo_row = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
    turns_raw = convo_row["turns"] if convo_row else []
    if isinstance(turns_raw, str):
        turns_raw = json.loads(turns_raw)
    turns: list = turns_raw or []

    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    current_scheda = scheda_raw

    # Recupero conoscenza: 1) Archivio Tecnico (documenti ufficiali), 2) casi simili già risolti
    rag_block = ""
    try:
        query = " ".join(filter(None, [
            row.get("vehicle") or "",
            current_scheda.get("marca") or "", current_scheda.get("modello") or "",
            current_scheda.get("motore") or "", user_text,
        ]))
        docs = await _find_knowledge(query)
        if docs:
            estratti = "\n---\n".join(
                f"[Documento: {d['title']} — pertinenza {d['similarity']:.0%}]\n{d['content'][:800]}"
                for d in docs
            )
            rag_block += (
                "\n\nDOCUMENTAZIONE TECNICA DELL'OFFICINA — FONTE PRIORITARIA "
                "(se il dato richiesto è qui, usa QUESTO e cita il titolo del documento; "
                "la tua conoscenza generale viene DOPO questi documenti):\n" + estratti
            )
            logger.info(f"archivio tecnico: {len(docs)} documenti pertinenti per {order_id}")
        similar = await _find_similar_cases(query, order_id)
        if similar:
            casi = "\n---\n".join(
                f"[{s['plate']} — {s['vehicle']} — somiglianza {s['similarity']:.0%}]\n{s['content'][:700]}"
                for s in similar
            )
            rag_block += (
                "\n\nCASI SIMILI GIÀ RISOLTI IN QUESTA OFFICINA "
                "(usali solo se pertinenti; quando li richiami cita la targa del caso):\n" + casi
            )
            logger.info(f"memoria storica: {len(similar)} casi simili per {order_id}")
    except Exception as e:
        logger.warning(f"recupero conoscenza fallito: {e}")

    # Le note scritte agli eventi (INIZIA/PAUSA/RIPRENDI/COMPLETA) e i km per evento
    # fanno parte del contesto: l'AI deve sapere cosa è già successo su questo lavoro.
    eventi_block = ""
    try:
        evs = await fetch(
            "SELECT type, reason, km, worker_full_name, timestamp FROM work_events WHERE work_order_id=$1 ORDER BY timestamp ASC LIMIT 30",
            order_id
        )
        if evs:
            righe_ev = []
            for e in evs:
                parti = [e["timestamp"].strftime("%d/%m %H:%M"), e["type"], e["worker_full_name"]]
                if e.get("km"):
                    parti.append(f"km={e['km']}")
                if e.get("reason"):
                    parti.append(f"nota: {e['reason']}")
                righe_ev.append(" ".join(parti))
            eventi_block = "\nEVENTI DI QUESTO LAVORO:\n  " + "\n  ".join(righe_ev)
    except Exception as e:
        logger.warning(f"eventi block fallito: {e}")

    # LE FOTO DELLA COMMESSA. Il modello che guarda le immagini le ha già lette e
    # descritte: nel libretto c'è l'alimentazione e il codice motore, sulle scatole
    # dei ricambi ci sono i codici veri. Finora l'assistente del meccanico NON le
    # riceveva — e il 3 agosto ha dato per diesel una Clio che il libretto,
    # fotografato mezz'ora prima, dichiarava BENZINA/GPL.
    foto_block = ""
    try:
        foto = await fetch(
            """SELECT kind, caption, created_at FROM order_photos
               WHERE work_order_id=$1 AND caption IS NOT NULL AND caption <> ''
               ORDER BY (kind='libretto') DESC, created_at DESC LIMIT 8""",
            order_id,
        )
        if foto:
            righe_foto = []
            for f in foto:
                etichetta = "LIBRETTO DEL VEICOLO" if f["kind"] == "libretto" else "foto"
                righe_foto.append(f"[{etichetta}] {f['caption']}")
            foto_block = (
                "\n\nFOTO SCATTATE SU QUESTO LAVORO (lette una per una, sono dati REALI di "
                "questa macchina — valgono più di quello che credi di sapere sul modello):\n  "
                + "\n  ".join(righe_foto)
            )
    except Exception as e:
        logger.warning(f"foto block fallito: {e}")

    try:
        messages = [{"role": "system", "content": ai.SYSTEM_ASSISTANT}]
        # Elenchiamo SOLO i dati che abbiamo davvero: i "?" facevano sembrare
        # all'AI che mancasse qualcosa da chiedere all'operaio.
        noti = [f"targa {row['plate']}"]
        if (row["customer"] or "").strip().upper() not in PLACEHOLDER_CLIENTE:
            noti.append(f"cliente {row['customer']}")
        if (row["vehicle"] or "").strip().upper() not in PLACEHOLDER_VEICOLO:
            noti.append(f"veicolo {row['vehicle']}")
        for chiave in ("marca", "modello", "anno", "motore", "km"):
            valore = str(current_scheda.get(chiave) or "").strip()
            if valore:
                noti.append(f"{chiave} {valore}")
        veicolo_block = (
            "VEICOLO SU CUI STAI LAVORANDO (dati reali, ancoraci ogni risposta tecnica):\n"
            f"  {' | '.join(noti)}\n"
            "  Questi dati li hai già: NON chiederli all'operaio. Se un dato non è nell'elenco "
            "vuol dire che il gestionale non ce l'ha ancora: lavora lo stesso senza chiederlo."
        )
        prefix = (
            f"{veicolo_block}\n"
            f"SCHEDA ATTUALE COMPLETA: {json.dumps(current_scheda, ensure_ascii=False)}"
            f"{eventi_block}"
            f"{foto_block}"
            f"{rag_block}"
        )
        for t in turns[-6:]:
            role = "user" if t["role"] == "user" else "assistant"
            messages.append({"role": role, "content": t["text"]})
        messages.append({"role": "user", "content": f"{prefix}\n\nOPERAIO ({user['full_name']}) dice ora: {user_text}"})

        raw = await ai.chat(messages, json=True, max_tokens=800)
    except Exception as e:
        msg = str(e)
        status_code = 429 if "429" in msg or "rate" in msg.lower() else 500
        logger.exception("voice-turn LLM failed")
        raise HTTPException(status_code=status_code, detail=f"AI fallita: {e}")

    parsed = _extract_json_block(raw)
    if parsed and isinstance(parsed, dict):
        reply = str(parsed.get("reply") or "Annotato.")
        scheda_in = parsed.get("scheda") or {}
        merged = dict(current_scheda)
        for k in ("marca", "modello", "anno", "motore", "km", "note"):
            v = scheda_in.get(k)
            if isinstance(v, str) and v.strip() and v.strip().lower() not in {"...", "null", "none"}:
                merged[k] = v.strip()
        for k in ("lavori_fatti", "lavori_da_fare", "ricambi_necessari"):
            new_list = scheda_in.get(k) or []
            if isinstance(new_list, list):
                combined = list(current_scheda.get(k) or [])
                for item in new_list:
                    if isinstance(item, str) and item.strip() and item.strip() not in combined:
                        combined.append(item.strip())
                merged[k] = combined
        scheda_final = SchedaTecnica(**merged)
    else:
        reply = raw.strip()
        scheda_final = SchedaTecnica(**current_scheda)

    now = now_utc()
    user_turn_d = {
        "role": "user", "text": user_text,
        "timestamp": now.isoformat(),
        "worker_id": user["id"], "worker_full_name": user["full_name"],
    }
    ai_turn_d = {"role": "assistant", "text": reply, "timestamp": now.isoformat()}
    new_turns = turns + [user_turn_d, ai_turn_d]

    await execute(
        """INSERT INTO conversations (work_order_id, turns, created_at, updated_at)
           VALUES ($1, $2::jsonb, $3, $3)
           ON CONFLICT (work_order_id) DO UPDATE SET turns=$2::jsonb, updated_at=$3""",
        order_id, json.dumps(new_turns), now
    )
    await execute(
        "UPDATE work_orders SET scheda_tecnica=$1::jsonb, updated_at=$2 WHERE id=$3",
        json.dumps(scheda_final.model_dump()), now, order_id
    )

    return VoiceTurnOut(
        assistant_text=reply,
        scheda_tecnica=_scheda_for_user(scheda_final, user),
        turn=ConversationTurn(role="assistant", text=reply, timestamp=now),
    )


@api.get("/work-orders/{order_id}/conversation", response_model=ConversationOut)
async def get_conversation(order_id: str, user: dict = Depends(get_current_user)):
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    worker_ids = row.get("assigned_worker_ids") or []
    if isinstance(worker_ids, str):
        worker_ids = json.loads(worker_ids)
    if user["role"] == "worker" and user["id"] not in worker_ids:
        raise HTTPException(status_code=403, detail="Non assegnato")
    convo_row = await fetchrow("SELECT turns FROM conversations WHERE work_order_id=$1", order_id)
    turns_raw = convo_row["turns"] if convo_row else []
    if isinstance(turns_raw, str):
        turns_raw = json.loads(turns_raw)
    turns = turns_raw or []
    scheda_raw = row.get("scheda_tecnica") or {}
    if isinstance(scheda_raw, str):
        scheda_raw = json.loads(scheda_raw)
    scheda = SchedaTecnica(**scheda_raw)

    parsed_turns = []
    for t in turns:
        ts = t.get("timestamp")
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts)
        parsed_turns.append(ConversationTurn(
            role=t["role"], text=t["text"], timestamp=ts,
            worker_id=t.get("worker_id"), worker_full_name=t.get("worker_full_name")
        ))
    return ConversationOut(work_order_id=order_id, scheda_tecnica=_scheda_for_user(scheda, user), turns=parsed_turns)


def _genera_html_stampa(orders: List[WorkOrder], workers: List[dict]) -> str:
    """Genera HTML stampabile con CSS print-friendly."""
    now_str = datetime.now(FUSO_ITALIA).strftime("%d/%m/%Y %H:%M")

    html_rows = ""
    for o in orders:
        status_label = {"open": "APERTA", "in_progress": "IN CORSO", "paused": "IN PAUSA", "completed": "COMPLETATA"}.get(o.status, o.status.upper())
        assigned_names = ", ".join([w["full_name"] for w in workers if w["id"] in (o.assigned_worker_ids or [])])

        html_rows += f"""
        <div class="order-card">
            <div class="order-header">
                <span class="plate">{o.plate}</span>
                <span class="status">{status_label}</span>
            </div>
            <div class="order-info">
                <p><strong>Veicolo:</strong> {o.vehicle or "-"}</p>
                <p><strong>Cliente:</strong> {o.customer or "-"}</p>
                <p><strong>Descrizione:</strong> {o.description or "-"}</p>
                <p><strong>Assegnati:</strong> {assigned_names or "Nessuno"}</p>
                <p><strong>Aperta:</strong> {o.created_at.strftime("%d/%m/%Y %H:%M") if o.created_at else "-"}</p>
            </div>
        </div>
        """

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stampa Commesse</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: Arial, sans-serif; font-size: 12px; color: #333; background: white; line-height: 1.6; }}
        .header {{ text-align: center; padding: 20px; border-bottom: 2px solid #000; margin-bottom: 20px; }}
        .header h1 {{ font-size: 24px; margin-bottom: 5px; font-weight: 900; }}
        .header p {{ font-size: 11px; color: #666; margin: 3px 0; }}
        .order-card {{
            border: 1px solid #ddd;
            padding: 15px;
            margin-bottom: 15px;
            page-break-inside: avoid;
            background: #fafafa;
        }}
        .order-header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 10px;
            border-bottom: 1px solid #eee;
            margin-bottom: 10px;
        }}
        .plate {{ font-weight: bold; font-size: 16px; }}
        .status {{
            display: inline-block;
            background: #ff9800;
            color: white;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: bold;
        }}
        .order-info p {{ margin: 5px 0; line-height: 1.5; font-size: 11px; }}
        .order-info strong {{ min-width: 100px; display: inline-block; font-weight: bold; }}
        @media print {{
            body {{ margin: 0; padding: 0; background: white; }}
            .order-card {{ page-break-inside: avoid; margin-bottom: 12px; }}
            .header {{ margin-bottom: 15px; }}
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>COMMESSE OFFICINA VALENTE</h1>
        <p>Stampa del {now_str}</p>
        <p>Totale: {len(orders)} commessa/e</p>
    </div>
    {html_rows}
</body>
</html>"""

    return html


@api.post("/work-orders/stampa-html")
async def stampa_orders_html(body: PrintOrdersIn, admin: dict = Depends(require_admin)):
    """Genera HTML formattato per stampa PDF o diretta di commesse selezionate."""
    try:
        if not body.order_ids:
            raise HTTPException(status_code=400, detail="Nessuna commessa selezionata")

        orders = []
        for oid in body.order_ids[:100]:
            row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", oid)
            if row:
                orders.append(row_to_workorder(row))

        if not orders:
            raise HTTPException(status_code=404, detail="Nessuna commessa trovata")

        workers = await fetch("SELECT id, full_name FROM users WHERE role='worker'")
        workers_list = workers if workers else []

        html = _genera_html_stampa(orders, workers_list)
        return HTMLResponse(content=html)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Errore in stampa_orders_html: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Errore: {str(e)}")


app.include_router(api)
