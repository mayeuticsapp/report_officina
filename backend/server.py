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

from fastapi import FastAPI, APIRouter, HTTPException, Depends, status
from fastapi.security import OAuth2PasswordBearer
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pydantic import BaseModel, Field
import jwt
import bcrypt

from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------- Config ----------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_DAYS = int(os.environ.get("JWT_EXPIRES_DAYS", "7"))
EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]
SEED_ADMIN_USERNAME = os.environ.get("SEED_ADMIN_USERNAME", "admin")
SEED_ADMIN_PASSWORD = os.environ.get("SEED_ADMIN_PASSWORD", "admin123")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# Collections
users_col = db.users
work_orders_col = db.work_orders
events_col = db.work_events

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
    """Use Claude to briefly interpret the pause/action reason (Italian)."""
    if not reason:
        return None
    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"reason-{uuid.uuid4()}",
            system_message=(
                "Sei un assistente per un'officina meccanica. Ricevi il motivo di un evento "
                "(START/PAUSE/RESUME/COMPLETE) scritto in linguaggio naturale da un operaio. "
                "Rispondi in italiano con UNA SOLA FRASE breve (max 15 parole) che riassume "
                "l'intento dell'operaio in modo strutturato per il capofficina."
            ),
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        msg = UserMessage(text=f"Evento: {event_type}\nMotivo dell'operaio: {reason}")
        resp = await chat.send_message(msg)
        return str(resp).strip()
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
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"daily-{uuid.uuid4()}",
            system_message=(
                "Sei l'assistente AI di un capofficina. Analizza gli eventi della giornata "
                "e genera un REPORT strutturato in italiano con: "
                "1) Riepilogo generale (numero operai attivi, commesse toccate). "
                "2) Timeline sintetica per operaio. "
                "3) Anomalie o pause lunghe (>30 min). "
                "4) Suggerimenti operativi. "
                "Sii conciso, professionale, usa elenchi puntati."
            ),
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        resp = await chat.send_message(UserMessage(text=f"Eventi di oggi:\n{events_text}"))
        return {"report": str(resp), "events_count": len(events)}
    except Exception as e:
        logger.warning(f"Daily report failed: {e}")
        return {"report": f"Errore generazione AI report. Eventi grezzi:\n{events_text}", "events_count": len(events)}


app.include_router(api)
