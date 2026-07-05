"""
Officina Meccanica - Backend API
FastAPI + MongoDB + JWT + Claude Sonnet 4.5 (via Emergent LLM key)
"""
import os
import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal

import io
import json
import re
import tempfile

from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, UploadFile, File
from fastapi.security import OAuth2PasswordBearer
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pydantic import BaseModel, Field
import jwt
import bcrypt

from mistralai.client import Mistral

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------- Config ----------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_DAYS = int(os.environ.get("JWT_EXPIRES_DAYS", "7"))
MISTRAL_API_KEY = os.environ["MISTRAL_API_KEY"]
MISTRAL_TEXT_MODEL = os.environ.get("MISTRAL_TEXT_MODEL", "mistral-large-latest")
MISTRAL_OCR_MODEL = os.environ.get("MISTRAL_OCR_MODEL", "mistral-ocr-latest")
MISTRAL_STT_MODEL = os.environ.get("MISTRAL_STT_MODEL", "voxtral-mini-latest")
SEED_ADMIN_USERNAME = os.environ.get("SEED_ADMIN_USERNAME", "admin")
SEED_ADMIN_PASSWORD = os.environ.get("SEED_ADMIN_PASSWORD", "admin123")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# Mistral AI client (shared)
mistral_client = Mistral(api_key=MISTRAL_API_KEY)

# Collections
users_col = db.users
work_orders_col = db.work_orders
events_col = db.work_events
conversations_col = db.conversations  # one doc per work_order_id with list of turns

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("officina")


# ---------------- Helpers ----------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


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


async def get_current_user(token: Optional[str] = Depends(oauth2)) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Non autenticato")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Sessione scaduta")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token non valido")
    user = await users_col.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="Utente non trovato")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Solo amministratori")
    return user


# ---------------- Models ----------------
Role = Literal["admin", "worker"]
EventType = Literal["START", "PAUSE", "RESUME", "COMPLETE"]
OrderStatus = Literal["open", "in_progress", "paused", "completed"]


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
    plate: str  # targa
    vin: Optional[str] = None
    customer: str  # cliente
    vehicle: str  # veicolo (marca modello)
    description: str
    assigned_worker_ids: List[str] = Field(default_factory=list)


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
    created_at: datetime
    updated_at: datetime


class WorkEventCreate(BaseModel):
    type: EventType
    reason: Optional[str] = None
    photos_base64: List[str] = Field(default_factory=list)  # ["data:image/jpeg;base64,..."]


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


# ---------------- Startup: seed admin ----------------
@app.on_event("startup")
async def startup():
    await users_col.create_index("username", unique=True)
    existing = await users_col.find_one({"username": SEED_ADMIN_USERNAME})
    if not existing:
        admin = {
            "id": str(uuid.uuid4()),
            "username": SEED_ADMIN_USERNAME,
            "password_hash": hash_password(SEED_ADMIN_PASSWORD),
            "full_name": "Titolare",
            "role": "admin",
            "created_at": now_utc(),
        }
        await users_col.insert_one(admin)
        logger.info(f"Seeded admin user: {SEED_ADMIN_USERNAME}")


@app.on_event("shutdown")
async def shutdown():
    client.close()


# ---------------- Routes ----------------
@api.get("/")
async def root():
    return {"message": "Officina Meccanica API", "status": "ok"}


# ---- Auth ----
@api.post("/auth/login", response_model=LoginOut)
async def login(body: LoginIn):
    user = await users_col.find_one({"username": body.username})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenziali non valide")
    token = create_token(user["id"], user["username"], user["role"])
    public = UserPublic(**{k: user[k] for k in ("id", "username", "full_name", "role", "created_at")})
    return LoginOut(token=token, user=public)


@api.get("/auth/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)):
    return UserPublic(**user)


# ---- Users (admin only) ----
@api.get("/users", response_model=List[UserPublic])
async def list_users(user: dict = Depends(require_admin)):
    users = await users_col.find({}, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(500)
    return [UserPublic(**u) for u in users]


@api.post("/users", response_model=UserPublic)
async def create_user(body: UserCreate, admin: dict = Depends(require_admin)):
    exists = await users_col.find_one({"username": body.username})
    if exists:
        raise HTTPException(status_code=400, detail="Username già in uso")
    new_user = {
        "id": str(uuid.uuid4()),
        "username": body.username,
        "password_hash": hash_password(body.password),
        "full_name": body.full_name,
        "role": body.role,
        "created_at": now_utc(),
    }
    await users_col.insert_one(new_user)
    return UserPublic(**{k: new_user[k] for k in ("id", "username", "full_name", "role", "created_at")})


@api.put("/users/{user_id}", response_model=UserPublic)
async def update_user(user_id: str, body: UserUpdate, admin: dict = Depends(require_admin)):
    update = {}
    if body.full_name is not None:
        update["full_name"] = body.full_name
    if body.password:
        update["password_hash"] = hash_password(body.password)
    if body.role is not None:
        update["role"] = body.role
    if not update:
        raise HTTPException(status_code=400, detail="Nessun campo da aggiornare")
    result = await users_col.find_one_and_update(
        {"id": user_id}, {"$set": update},
        projection={"_id": 0, "password_hash": 0},
        return_document=True,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Utente non trovato")
    return UserPublic(**result)


@api.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Non puoi eliminare te stesso")
    res = await users_col.delete_one({"id": user_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Utente non trovato")
    return {"ok": True}


# ---- Work Orders ----
@api.get("/work-orders", response_model=List[WorkOrder])
async def list_work_orders(user: dict = Depends(get_current_user)):
    query = {}
    if user["role"] == "worker":
        query = {"assigned_worker_ids": user["id"]}
    orders = await work_orders_col.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [WorkOrder(**o) for o in orders]


@api.post("/work-orders", response_model=WorkOrder)
async def create_work_order(body: WorkOrderCreate, admin: dict = Depends(require_admin)):
    order = {
        "id": str(uuid.uuid4()),
        "plate": body.plate,
        "vin": body.vin,
        "customer": body.customer,
        "vehicle": body.vehicle,
        "description": body.description,
        "assigned_worker_ids": body.assigned_worker_ids,
        "status": "open",
        "scheda_tecnica": SchedaTecnica().model_dump(),
        "created_at": now_utc(),
        "updated_at": now_utc(),
    }
    await work_orders_col.insert_one(order)
    return WorkOrder(**{k: order[k] for k in order if k != "_id"})


@api.get("/work-orders/{order_id}", response_model=WorkOrder)
async def get_work_order(order_id: str, user: dict = Depends(get_current_user)):
    order = await work_orders_col.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if user["role"] == "worker" and user["id"] not in order["assigned_worker_ids"]:
        raise HTTPException(status_code=403, detail="Non assegnato")
    return WorkOrder(**order)


@api.put("/work-orders/{order_id}", response_model=WorkOrder)
async def update_work_order(order_id: str, body: WorkOrderUpdate, admin: dict = Depends(require_admin)):
    update = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not update:
        raise HTTPException(status_code=400, detail="Nessun campo")
    update["updated_at"] = now_utc()
    result = await work_orders_col.find_one_and_update(
        {"id": order_id}, {"$set": update}, projection={"_id": 0}, return_document=True
    )
    if not result:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    return WorkOrder(**result)


@api.delete("/work-orders/{order_id}")
async def delete_work_order(order_id: str, admin: dict = Depends(require_admin)):
    await events_col.delete_many({"work_order_id": order_id})
    res = await work_orders_col.delete_one({"id": order_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Non trovata")
    return {"ok": True}


# ---- Work Events (worker actions) ----
async def _ai_interpret_reason(reason: str, event_type: str) -> Optional[str]:
    """Use Mistral to briefly interpret the pause/action reason (Italian)."""
    if not reason:
        return None
    try:
        resp = await mistral_client.chat.complete_async(
            model=MISTRAL_TEXT_MODEL,
            messages=[
                {"role": "system", "content": (
                    "Sei un assistente per un'officina meccanica. Ricevi il motivo di un evento "
                    "(START/PAUSE/RESUME/COMPLETE) scritto in linguaggio naturale da un operaio. "
                    "Rispondi in italiano con UNA SOLA FRASE breve (max 15 parole) che riassume "
                    "l'intento dell'operaio in modo strutturato per il capofficina."
                )},
                {"role": "user", "content": f"Evento: {event_type}\nMotivo dell'operaio: {reason}"},
            ],
            max_tokens=100,
        )
        return (resp.choices[0].message.content or "").strip() or None
    except Exception as e:
        logger.warning(f"AI interpret failed: {e}")
        return None


@api.post("/work-orders/{order_id}/events", response_model=WorkEvent)
async def add_event(order_id: str, body: WorkEventCreate, user: dict = Depends(get_current_user)):
    order = await work_orders_col.find_one({"id": order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if user["role"] == "worker" and user["id"] not in order["assigned_worker_ids"]:
        raise HTTPException(status_code=403, detail="Non assegnato a questa commessa")

    ai_note = await _ai_interpret_reason(body.reason or "", body.type) if body.reason else None

    event = {
        "id": str(uuid.uuid4()),
        "work_order_id": order_id,
        "worker_id": user["id"],
        "worker_username": user["username"],
        "worker_full_name": user["full_name"],
        "type": body.type,
        "reason": body.reason,
        "photos_base64": body.photos_base64,
        "timestamp": now_utc(),
        "ai_interpretation": ai_note,
    }
    await events_col.insert_one(event)

    # Update order status
    new_status_map = {"START": "in_progress", "RESUME": "in_progress", "PAUSE": "paused", "COMPLETE": "completed"}
    await work_orders_col.update_one(
        {"id": order_id},
        {"$set": {"status": new_status_map[body.type], "updated_at": now_utc()}},
    )
    return WorkEvent(**{k: event[k] for k in event if k != "_id"})


@api.get("/work-orders/{order_id}/events", response_model=List[WorkEvent])
async def list_events(order_id: str, user: dict = Depends(get_current_user)):
    order = await work_orders_col.find_one({"id": order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if user["role"] == "worker" and user["id"] not in order["assigned_worker_ids"]:
        raise HTTPException(status_code=403, detail="Non assegnato")
    events = await events_col.find({"work_order_id": order_id}, {"_id": 0}).sort("timestamp", 1).to_list(1000)
    return [WorkEvent(**e) for e in events]


@api.get("/events/recent", response_model=List[WorkEvent])
async def recent_events(limit: int = 50, admin: dict = Depends(require_admin)):
    events = await events_col.find({}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    return [WorkEvent(**e) for e in events]


# ---- Live status ----
@api.get("/workers/live-status", response_model=List[LiveWorkerStatus])
async def workers_live_status(admin: dict = Depends(require_admin)):
    workers = await users_col.find({"role": "worker"}, {"_id": 0, "password_hash": 0}).to_list(500)
    result: List[LiveWorkerStatus] = []
    now = now_utc()
    for w in workers:
        last = await events_col.find_one(
            {"worker_id": w["id"]}, {"_id": 0}, sort=[("timestamp", -1)]
        )
        if not last or last["type"] == "COMPLETE":
            result.append(LiveWorkerStatus(
                worker_id=w["id"], username=w["username"], full_name=w["full_name"],
                current_status="idle",
            ))
            continue
        status_str = "working" if last["type"] in ("START", "RESUME") else "paused"
        order = await work_orders_col.find_one({"id": last["work_order_id"]}, {"_id": 0})
        label = f"{order['plate']} - {order['vehicle']}" if order else None
        ts = last["timestamp"]
        # Ensure tz-aware
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
@api.get("/reports/daily")
async def daily_report(admin: dict = Depends(require_admin)):
    """AI-generated report of today's activities."""
    start = datetime(now_utc().year, now_utc().month, now_utc().day, tzinfo=timezone.utc)
    events = await events_col.find(
        {"timestamp": {"$gte": start}}, {"_id": 0}
    ).sort("timestamp", 1).to_list(2000)

    if not events:
        return {"report": "Nessuna attività registrata oggi.", "events_count": 0}

    # Compact events for the LLM
    summary_lines = []
    for e in events:
        ts = e["timestamp"]
        if isinstance(ts, datetime):
            t = ts.strftime("%H:%M")
        else:
            t = str(ts)
        reason = f" — {e['reason']}" if e.get("reason") else ""
        summary_lines.append(f"[{t}] {e['worker_full_name']}: {e['type']}{reason}")
    events_text = "\n".join(summary_lines)

    try:
        resp = await mistral_client.chat.complete_async(
            model=MISTRAL_TEXT_MODEL,
            messages=[
                {"role": "system", "content": (
                    "Sei l'assistente AI di un capofficina. Analizza gli eventi della giornata "
                    "e genera un REPORT strutturato in italiano con: "
                    "1) Riepilogo generale (numero operai attivi, commesse toccate). "
                    "2) Timeline sintetica per operaio. "
                    "3) Anomalie o pause lunghe (>30 min). "
                    "4) Suggerimenti operativi. "
                    "Sii conciso, professionale, usa elenchi puntati."
                )},
                {"role": "user", "content": f"Eventi di oggi:\n{events_text}"},
            ],
            max_tokens=1500,
        )
        content = (resp.choices[0].message.content or "").strip()
        return {"report": content, "events_count": len(events)}
    except Exception as e:
        logger.warning(f"Daily report failed: {e}")
        return {"report": f"Errore generazione AI report. Eventi grezzi:\n{events_text}", "events_count": len(events)}


# ---- Vision: plate OCR ----
class PlateOcrIn(BaseModel):
    image_base64: str  # raw base64 (no data: prefix) or with prefix


class PlateOcrOut(BaseModel):
    plate: Optional[str] = None
    raw: str


PLATE_RE = re.compile(r"[A-Z]{2}\s?[0-9]{3}\s?[A-Z]{2}")


@api.post("/vision/plate", response_model=PlateOcrOut)
async def ocr_plate(body: PlateOcrIn, user: dict = Depends(get_current_user)):
    """OCR di una targa italiana da foto usando Mistral OCR."""
    b64 = body.image_base64
    if "," in b64 and b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    data_url = f"data:image/jpeg;base64,{b64}"
    try:
        # Mistral OCR extracts all text as structured markdown
        ocr_resp = await mistral_client.ocr.process_async(
            model=MISTRAL_OCR_MODEL,
            document={"type": "image_url", "image_url": data_url},
        )
        # Aggregate text from all pages
        pages_text = " ".join((p.markdown or "") for p in (ocr_resp.pages or []))
        raw = pages_text.strip().upper()
        m = PLATE_RE.search(raw.replace("-", "").replace(".", "").replace("\n", " "))
        plate = m.group(0).replace(" ", "") if m else None
        return PlateOcrOut(plate=plate, raw=(raw[:200] if raw else "NON_TROVATA"))
    except Exception as e:
        # Provider errors (image unreadable, corrupt, too small) → soft-fail with 200
        logger.warning(f"plate ocr soft-fail: {e}")
        return PlateOcrOut(plate=None, raw="NON_TROVATA")


# ---- Audio: transcription (Whisper-1) ----
class TranscribeOut(BaseModel):
    text: str


@api.post("/audio/transcribe", response_model=TranscribeOut)
async def transcribe_audio(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Trascrive un file audio (m4a/mp3/wav/webm) usando Mistral Voxtral."""
    data = await file.read()
    filename = file.filename or "audio.m4a"
    try:
        resp = await mistral_client.audio.transcriptions.complete_async(
            model=MISTRAL_STT_MODEL,
            file={"content": data, "file_name": filename},
            language="it",
        )
        # Mistral SDK returns object with .text (transcription)
        text = getattr(resp, "text", None)
        if text is None:
            text = getattr(resp, "transcription", None)
        if text is None and isinstance(resp, dict):
            text = resp.get("text") or resp.get("transcription")
        return TranscribeOut(text=(text or "").strip())
    except Exception as e:
        logger.exception("transcribe failed")
        raise HTTPException(status_code=500, detail=f"Trascrizione fallita: {e}")


# ---- AI Voice Chat (multi-turn per commessa) ----
class VoiceTurnIn(BaseModel):
    user_text: str  # trascritto lato client oppure via /audio/transcribe


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    timestamp: datetime
    worker_id: Optional[str] = None
    worker_full_name: Optional[str] = None


class VoiceTurnOut(BaseModel):
    assistant_text: str
    scheda_tecnica: SchedaTecnica
    turn: ConversationTurn


class ConversationOut(BaseModel):
    work_order_id: str
    scheda_tecnica: SchedaTecnica
    turns: List[ConversationTurn]


AI_SYSTEM_PROMPT = (
    "Sei l'assistente AI di un'officina meccanica italiana. Parli con un OPERAIO che ha le mani "
    "occupate e ti detta note vocali sul lavoro in corso su un veicolo. "
    "Il tuo compito duplice: "
    "(1) rispondere all'operaio con UNA frase breve (max 20 parole) — conferma, chiedi info mancanti "
    "(marca/modello/anno, KM, cosa fatto, cosa manca, ricambi), non ripetere ciò che ha detto. "
    "(2) mantenere aggiornata la scheda tecnica strutturata. "
    "Rispondi SEMPRE con un JSON valido (senza testo intorno, senza markdown) con questa struttura ESATTA:\n"
    "{\n"
    '  "reply": "risposta breve all\'operaio in italiano",\n'
    '  "scheda": {\n'
    '    "marca": "stringa o null", "modello": "stringa o null", "anno": "stringa o null",\n'
    '    "motore": "stringa o null", "km": "stringa o null",\n'
    '    "lavori_fatti": ["..."], "lavori_da_fare": ["..."], "ricambi_necessari": ["..."],\n'
    '    "note": "stringa o null"\n'
    "  }\n"
    "}\n"
    "Nella scheda accumula ciò che sai: mantieni i valori già presenti + aggiungi i nuovi. "
    "Le liste devono contenere gli elementi già noti + i nuovi (deduplica)."
)


def _extract_json_block(s: str) -> Optional[dict]:
    # Look for ```json ... ``` block first, else find first {...}
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", s, re.DOTALL)
    if not m:
        m = re.search(r"(\{.*\})", s, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


@api.post("/work-orders/{order_id}/voice-turn", response_model=VoiceTurnOut)
async def voice_turn(order_id: str, body: VoiceTurnIn, user: dict = Depends(get_current_user)):
    order = await work_orders_col.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if user["role"] == "worker" and user["id"] not in order["assigned_worker_ids"]:
        raise HTTPException(status_code=403, detail="Non assegnato a questa commessa")

    user_text = body.user_text.strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Testo vuoto")

    convo_doc = await conversations_col.find_one({"work_order_id": order_id}, {"_id": 0})
    turns: list = (convo_doc or {}).get("turns", [])
    current_scheda = order.get("scheda_tecnica") or SchedaTecnica().model_dump()

    try:
        # Build message history: system + optional prior turns + current user message
        messages = [{"role": "system", "content": AI_SYSTEM_PROMPT}]
        # Include a compact context as first user turn
        prefix = (
            f"COMMESSA: targa={order['plate']}, veicolo={order['vehicle']}, cliente={order['customer']}\n"
            f"SCHEDA ATTUALE: {json.dumps(current_scheda, ensure_ascii=False)}"
        )
        # Add up to last 6 conversation turns for continuity
        for t in turns[-6:]:
            role = "user" if t["role"] == "user" else "assistant"
            messages.append({"role": role, "content": t["text"]})
        # Prepend context to current user turn
        messages.append({"role": "user", "content": f"{prefix}\n\nOPERAIO ({user['full_name']}) dice ora: {user_text}"})

        resp = await mistral_client.chat.complete_async(
            model=MISTRAL_TEXT_MODEL,
            messages=messages,
            response_format={"type": "json_object"},
            max_tokens=800,
        )
        raw = resp.choices[0].message.content or ""
    except Exception as e:
        logger.exception("voice-turn LLM failed")
        raise HTTPException(status_code=500, detail=f"AI fallita: {e}")

    parsed = _extract_json_block(raw)
    if parsed and isinstance(parsed, dict):
        reply = str(parsed.get("reply") or "Annotato.")
        scheda_in = parsed.get("scheda") or {}
        # Merge: strings replaced only if non-empty; lists deduped & extended
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
    user_turn = {
        "role": "user", "text": user_text, "timestamp": now,
        "worker_id": user["id"], "worker_full_name": user["full_name"],
    }
    ai_turn = {
        "role": "assistant", "text": reply, "timestamp": now,
    }

    await conversations_col.update_one(
        {"work_order_id": order_id},
        {"$setOnInsert": {"work_order_id": order_id, "created_at": now},
         "$push": {"turns": {"$each": [user_turn, ai_turn]}}},
        upsert=True,
    )
    await work_orders_col.update_one(
        {"id": order_id},
        {"$set": {"scheda_tecnica": scheda_final.model_dump(), "updated_at": now}},
    )

    return VoiceTurnOut(
        assistant_text=reply,
        scheda_tecnica=scheda_final,
        turn=ConversationTurn(**ai_turn),
    )


@api.get("/work-orders/{order_id}/conversation", response_model=ConversationOut)
async def get_conversation(order_id: str, user: dict = Depends(get_current_user)):
    order = await work_orders_col.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Commessa non trovata")
    if user["role"] == "worker" and user["id"] not in order["assigned_worker_ids"]:
        raise HTTPException(status_code=403, detail="Non assegnato")
    convo = await conversations_col.find_one({"work_order_id": order_id}, {"_id": 0})
    turns = (convo or {}).get("turns", []) if convo else []
    scheda = SchedaTecnica(**(order.get("scheda_tecnica") or {}))
    return ConversationOut(work_order_id=order_id, scheda_tecnica=scheda, turns=[ConversationTurn(**t) for t in turns])


app.include_router(api)
