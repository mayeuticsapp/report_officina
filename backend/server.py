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
import tempfile
import io
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal

import asyncpg
from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, UploadFile, File, Header
from fastapi.responses import FileResponse
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
        "SELECT id, username, full_name, role, created_at FROM users WHERE id=$1",
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
EventType = Literal["START", "PAUSE", "RESUME", "COMPLETE"]
OrderStatus = Literal["pending", "open", "in_progress", "paused", "completed"]


class UserPublic(BaseModel):
    id: str
    username: str
    full_name: str
    role: Role
    created_at: datetime


class UserCreate(BaseModel):
    username: str
    password: str
    full_name: str
    role: Role = "worker"


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Role] = None


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


class SchedaTecnica(BaseModel):
    marca: Optional[str] = None
    modello: Optional[str] = None
    anno: Optional[str] = None
    motore: Optional[str] = None
    km: Optional[str] = None
    lavori_fatti: List[str] = Field(default_factory=list)
    lavori_da_fare: List[str] = Field(default_factory=list)
    ricambi_necessari: List[str] = Field(default_factory=list)
    note: Optional[str] = None


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
    created_at: datetime
    updated_at: datetime


class WorkEventCreate(BaseModel):
    type: EventType
    reason: Optional[str] = None
    photos_base64: List[str] = Field(default_factory=list)


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
    public = UserPublic(**{k: user[k] for k in ("id", "username", "full_name", "role", "created_at")})
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
    rows = await fetch("SELECT id, username, full_name, role, created_at FROM users ORDER BY created_at DESC LIMIT 500")
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
    if not parts:
        raise HTTPException(status_code=400, detail="Nessun campo da aggiornare")
    vals.append(user_id)
    row = await fetchrow(
        f"UPDATE users SET {', '.join(parts)} WHERE id=${i} RETURNING id, username, full_name, role, created_at",
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
async def list_work_orders(q: Optional[str] = None, user: dict = Depends(get_current_user)):
    conds = []
    vals: list = []
    if user["role"] == "worker":
        vals.append(json.dumps([user["id"]]))
        conds.append(f"assigned_worker_ids @> ${len(vals)}::jsonb")
    if q and q.strip():
        vals.append(f"%{q.strip()}%")
        i = len(vals)
        conds.append(
            f"(plate ILIKE ${i} OR customer ILIKE ${i} OR vehicle ILIKE ${i} OR description ILIKE ${i} OR scheda_tecnica::text ILIKE ${i})"
        )
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = await fetch(f"SELECT * FROM work_orders {where} ORDER BY created_at DESC LIMIT 500", *vals)
    return [row_to_workorder(r) for r in rows]


@api.post("/work-orders", response_model=WorkOrder)
async def create_work_order(body: WorkOrderCreate, admin: dict = Depends(require_admin)):
    new_id = str(uuid.uuid4())
    now = now_utc()
    scheda = SchedaTecnica().model_dump()
    await execute(
        """INSERT INTO work_orders (id, plate, vin, customer, vehicle, description, assigned_worker_ids, status, scheda_tecnica, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11)""",
        new_id, body.plate, body.vin, body.customer, body.vehicle, body.description,
        json.dumps(body.assigned_worker_ids), "open", json.dumps(scheda), now, now
    )
    return WorkOrder(
        id=new_id, plate=body.plate, vin=body.vin, customer=body.customer,
        vehicle=body.vehicle, description=body.description,
        assigned_worker_ids=body.assigned_worker_ids, status="open",
        scheda_tecnica=SchedaTecnica(**scheda), created_at=now, updated_at=now
    )


@api.post("/work-orders/propose", response_model=WorkOrder)
async def propose_work_order(body: WorkOrderPropose, user: dict = Depends(get_current_user)):
    """Un operaio apre di sua iniziativa una scheda lavoro: resta 'pending' finché il titolare non la approva."""
    new_id = str(uuid.uuid4())
    now = now_utc()
    scheda = SchedaTecnica().model_dump()
    assigned = [user["id"]]
    customer = (body.customer or "").strip() or "DA INSERIRE"
    vehicle = (body.vehicle or "").strip() or "Da identificare"
    plate = body.plate.strip().upper().replace(" ", "")
    await execute(
        """INSERT INTO work_orders
           (id, plate, vin, customer, vehicle, description, assigned_worker_ids, status, scheda_tecnica, created_by, created_by_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)""",
        new_id, plate, body.vin, customer, vehicle, body.description,
        json.dumps(assigned), "pending", json.dumps(scheda), user["id"], user["full_name"], now, now
    )
    return WorkOrder(
        id=new_id, plate=plate, vin=body.vin, customer=customer,
        vehicle=vehicle, description=body.description,
        assigned_worker_ids=assigned, status="pending",
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


class OmniusSchedaIn(BaseModel):
    star_doc_id: str
    plate: str
    vin: Optional[str] = None
    customer: Optional[str] = None
    vehicle: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None
    dtc_codes: List[str] = Field(default_factory=list)


class OmniusSchedaOut(BaseModel):
    action: Literal["created", "updated"]
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

    # Le voci lavori/ricambi della scheda STAR diventano checklist (lavori_da_fare);
    # i DTC restano in nota.
    lavori_items = [s.strip() for s in (body.note or "").split(";") if s.strip()]
    extra_note = ("DTC: " + ", ".join(body.dtc_codes)) if body.dtc_codes else None

    existing = await fetchrow("SELECT * FROM work_orders WHERE star_doc_id=$1", star_doc_id)
    now = now_utc()

    if existing:
        scheda_raw = existing.get("scheda_tecnica") or {}
        if isinstance(scheda_raw, str):
            scheda_raw = json.loads(scheda_raw)
        merged_scheda = dict(scheda_raw)
        if lavori_items:
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
        vals.append(existing["id"])
        row = await fetchrow(f"UPDATE work_orders SET {', '.join(parts)} WHERE id=${i} RETURNING *", *vals)
        return OmniusSchedaOut(action="updated", work_order=row_to_workorder(row))

    new_id = str(uuid.uuid4())
    scheda = SchedaTecnica(note=extra_note, lavori_da_fare=lavori_items).model_dump()
    customer = (body.customer or "Cliente da definire").strip()
    vehicle = (body.vehicle or "Veicolo da definire").strip()
    description = (body.description or "Scheda ricevuta da Omnius/STAR").strip()
    await execute(
        """INSERT INTO work_orders
           (id, plate, vin, customer, vehicle, description, assigned_worker_ids, status, scheda_tecnica, created_by, created_by_name, star_doc_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14)""",
        new_id, plate, body.vin, customer, vehicle, description,
        json.dumps([]), "pending", json.dumps(scheda), "omnius", "Omnius (STAR)", star_doc_id, now, now
    )
    row = await fetchrow("SELECT * FROM work_orders WHERE id=$1", new_id)
    return OmniusSchedaOut(action="created", work_order=row_to_workorder(row))


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
    minutes_worked: int
    events: List[OmniusEventOut]
    scheda_tecnica: SchedaTecnica
    dialogo: List[dict]
    photos: List[OmniusPhotoOut]


class OmniusReportsOut(BaseModel):
    items: List[OmniusReportItem]
    count: int
    has_more: bool
    next_updated_since: Optional[datetime] = None


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
    return row_to_workorder(row)


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
    return scheda


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


@api.post("/work-orders/{order_id}/photos", response_model=OrderPhoto)
async def upload_order_photo(order_id: str, file: UploadFile = File(...), user: dict = Depends(get_current_user)):
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
    await execute(
        """INSERT INTO order_photos (id, work_order_id, uploaded_by, uploaded_by_name, content_type, size_bytes, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)""",
        photo_id, order_id, user["id"], user["full_name"], content_type, len(data), now,
    )
    return OrderPhoto(
        id=photo_id, work_order_id=order_id, uploaded_by=user["id"], uploaded_by_name=user["full_name"],
        content_type=content_type, size_bytes=len(data), created_at=now,
    )


@api.get("/work-orders/{order_id}/photos", response_model=List[OrderPhoto])
async def list_order_photos(order_id: str, user: dict = Depends(get_current_user)):
    await _order_or_403(order_id, user)
    rows = await fetch(
        "SELECT * FROM order_photos WHERE work_order_id=$1 ORDER BY created_at DESC", order_id
    )
    return [OrderPhoto(**dict(r)) for r in rows]


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
async def delete_photo(photo_id: str, admin: dict = Depends(require_admin)):
    row = await fetchrow("SELECT * FROM order_photos WHERE id=$1", photo_id)
    if not row:
        raise HTTPException(status_code=404, detail="Foto non trovata")
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


async def _push_to_users(user_ids: List[str], title: str, body: str, url: str = "/"):
    """Invia una notifica push a tutti i dispositivi registrati degli utenti dati. Soft-fail."""
    if not VAPID_PRIVATE_KEY_FILE or not user_ids:
        return
    try:
        subs = await fetch("SELECT * FROM push_subscriptions WHERE user_id = ANY($1)", user_ids)
        if not subs:
            return
        payload = json.dumps({"title": title, "body": body[:160], "url": url})
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
    if row["status"] == "pending":
        raise HTTPException(status_code=409, detail="Commessa in attesa di approvazione dal titolare")

    ai_note = await _ai_interpret_reason(body.reason or "", body.type) if body.reason else None
    event_id = str(uuid.uuid4())
    ts = now_utc()

    await execute(
        """INSERT INTO work_events (id, work_order_id, worker_id, worker_username, worker_full_name, type, reason, photos_base64, timestamp, ai_interpretation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)""",
        event_id, order_id, user["id"], user["username"], user["full_name"],
        body.type, body.reason, json.dumps(body.photos_base64), ts, ai_note
    )

    new_status_map = {"START": "in_progress", "RESUME": "in_progress", "PAUSE": "paused", "COMPLETE": "completed"}
    await execute(
        "UPDATE work_orders SET status=$1, updated_at=$2 WHERE id=$3",
        new_status_map[body.type], now_utc(), order_id
    )

    # A lavoro completato, il caso entra nella memoria storica dell'officina (in background)
    if body.type == "COMPLETE":
        asyncio.create_task(_upsert_case_embedding(order_id))

    return WorkEvent(
        id=event_id, work_order_id=order_id, worker_id=user["id"],
        worker_username=user["username"], worker_full_name=user["full_name"],
        type=body.type, reason=body.reason, photos_base64=body.photos_base64,
        timestamp=ts, ai_interpretation=ai_note
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
        last = await fetchrow(
            "SELECT * FROM work_events WHERE worker_id=$1 ORDER BY timestamp DESC LIMIT 1",
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
            "SELECT * FROM work_events WHERE timestamp>=$1 AND timestamp<$2 AND worker_id=ANY($3) ORDER BY timestamp ASC LIMIT 5000",
            day_start, day_end, filter_ids
        )
    else:
        workers = await fetch("SELECT id, username, full_name FROM users WHERE role='worker' LIMIT 500")
        events = await fetch(
            "SELECT * FROM work_events WHERE timestamp>=$1 AND timestamp<$2 ORDER BY timestamp ASC LIMIT 5000",
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
        raise HTTPException(status_code=404, detail="Richiesta non trovata")
    if req["status"] != "pending":
        return {"ok": True, "note": "richiesta già evasa"}
    order_id, plate = req["work_order_id"], req["plate"]

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
           (row["customer"] or "").strip().upper() in ("", "DA INSERIRE", "CLIENTE DA DEFINIRE"):
            await execute("UPDATE work_orders SET customer=$1, updated_at=$2 WHERE id=$3",
                          body.customer.strip(), now_utc(), order_id)
        vehicle_label = " ".join(filter(None, [body.make, body.model, body.year and f"({body.year})"]))
        if vehicle_label and \
           (row["vehicle"] or "").strip().upper() in ("", "DA IDENTIFICARE", "VEICOLO DA DEFINIRE", "DA DEFINIRE", "DA INSERIRE"):
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
               WHERE c.work_order_id != $2
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

    try:
        messages = [{"role": "system", "content": ai.SYSTEM_ASSISTANT}]
        veicolo_block = (
            "VEICOLO SU CUI STAI LAVORANDO (dati reali, ancoraci ogni risposta tecnica):\n"
            f"  targa: {row['plate']} | veicolo: {row['vehicle']} | cliente: {row['customer']}\n"
            f"  marca: {current_scheda.get('marca') or '?'} | modello: {current_scheda.get('modello') or '?'} | "
            f"anno: {current_scheda.get('anno') or '?'} | motore: {current_scheda.get('motore') or '?'} | "
            f"km: {current_scheda.get('km') or '?'}"
        )
        prefix = (
            f"{veicolo_block}\n"
            f"SCHEDA ATTUALE COMPLETA: {json.dumps(current_scheda, ensure_ascii=False)}"
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
        scheda_tecnica=scheda_final,
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
    return ConversationOut(work_order_id=order_id, scheda_tecnica=scheda, turns=parsed_turns)


app.include_router(api)
