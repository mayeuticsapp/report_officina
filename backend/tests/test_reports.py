"""
Report AI endpoint tests — new /api/reports/daily schema with worker filter,
date filter, per-worker breakdown, minutes_worked correctness, and RBAC.
"""
import os
import uuid
import time
from datetime import datetime, timezone, timedelta

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://car-bay-flow.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_USER = "admin"
ADMIN_PASS = "admin123"

_run_id = uuid.uuid4().hex[:8]


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_headers(session):
    r = session.post(f"{API}/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def ctx(session, admin_headers):
    """Create 2 fresh workers + 1 fresh order + login tokens for reuse."""
    data = {"cleanup_orders": [], "cleanup_users": []}

    # Two workers
    workers = []
    for suffix, name in (("a", "TEST A"), ("b", "TEST B")):
        u = {
            "username": f"TEST_rep_{suffix}_{_run_id}",
            "password": "pw12345",
            "full_name": f"{name} {_run_id}",
            "role": "worker",
        }
        r = session.post(f"{API}/users", headers=admin_headers, json=u)
        assert r.status_code == 200, r.text
        wid = r.json()["id"]
        data["cleanup_users"].append(wid)
        # Login
        lr = session.post(f"{API}/auth/login", json={"username": u["username"], "password": u["password"]})
        assert lr.status_code == 200, lr.text
        workers.append({
            "id": wid,
            "username": u["username"],
            "headers": {"Authorization": f"Bearer {lr.json()['token']}", "Content-Type": "application/json"},
        })
    data["worker_a"] = workers[0]
    data["worker_b"] = workers[1]

    # Order assigned to worker A
    op = {
        "plate": f"TEST-{_run_id.upper()}",
        "customer": "TEST Cliente",
        "vehicle": "Fiat Punto",
        "description": "Test report",
        "assigned_worker_ids": [workers[0]["id"]],
    }
    r = session.post(f"{API}/work-orders", headers=admin_headers, json=op)
    assert r.status_code == 200, r.text
    data["order_id"] = r.json()["id"]
    data["cleanup_orders"].append(data["order_id"])

    yield data

    # Cleanup
    for oid in data["cleanup_orders"]:
        session.delete(f"{API}/work-orders/{oid}", headers=admin_headers)
    for uid in data["cleanup_users"]:
        session.delete(f"{API}/users/{uid}", headers=admin_headers)


# -------- Schema & basic --------
class TestReportSchema:
    def test_daily_report_default_returns_new_schema(self, session, admin_headers):
        r = session.get(f"{API}/reports/daily", headers=admin_headers, timeout=90)
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("date", "filter_worker_ids", "workers", "total_events",
                  "total_minutes", "orders_touched", "narrative", "generated_at"):
            assert k in body, f"missing key {k}"
        assert body["filter_worker_ids"] == []
        assert isinstance(body["workers"], list)
        assert isinstance(body["narrative"], str) and len(body["narrative"]) > 0
        # Date is today
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        assert body["date"] == today

    def test_worker_role_forbidden(self, session, ctx):
        r = session.get(f"{API}/reports/daily", headers=ctx["worker_a"]["headers"])
        assert r.status_code == 403


# -------- Date filter --------
class TestReportDate:
    def test_past_date_no_events_returns_empty(self, session, admin_headers):
        past = (datetime.now(timezone.utc) - timedelta(days=365 * 3)).strftime("%Y-%m-%d")
        r = session.get(f"{API}/reports/daily?date={past}", headers=admin_headers, timeout=60)
        assert r.status_code == 200
        body = r.json()
        assert body["date"] == past
        assert body["total_events"] == 0
        assert body["total_minutes"] == 0
        assert body["orders_touched"] == 0
        assert "Nessuna attività" in body["narrative"]

    def test_bad_date_returns_400(self, session, admin_headers):
        r = session.get(f"{API}/reports/daily?date=BAD", headers=admin_headers)
        assert r.status_code == 400
        assert "data" in r.json().get("detail", "").lower() or "YYYY" in r.json().get("detail", "")


# -------- Worker filter --------
class TestReportWorkerFilter:
    def test_empty_worker_ids_means_all(self, session, admin_headers):
        r = session.get(f"{API}/reports/daily?worker_ids=", headers=admin_headers, timeout=90)
        assert r.status_code == 200
        assert r.json()["filter_worker_ids"] == []

    def test_filter_by_specific_worker(self, session, admin_headers, ctx):
        # Emit an event so worker_a shows up
        session.post(
            f"{API}/work-orders/{ctx['order_id']}/events",
            headers=ctx["worker_a"]["headers"],
            json={"type": "START"},
        )
        wid_a = ctx["worker_a"]["id"]
        r = session.get(f"{API}/reports/daily?worker_ids={wid_a}", headers=admin_headers, timeout=90)
        assert r.status_code == 200
        body = r.json()
        assert body["filter_worker_ids"] == [wid_a]
        # Only worker_a should be in the workers array
        ids_returned = [w["worker_id"] for w in body["workers"]]
        assert ids_returned == [wid_a], f"expected only worker_a, got {ids_returned}"


# -------- Minutes computation --------
class TestReportMinutes:
    def test_minutes_worked_across_pause_resume(self, session, admin_headers, ctx):
        """Insert events directly into MongoDB with controlled timestamps to
        verify _worker_minutes: START T, PAUSE T+10, RESUME T+20, COMPLETE T+35
        → expected 25 minutes."""
        try:
            from motor.motor_asyncio import AsyncIOMotorClient  # noqa: F401
        except Exception:
            pytest.skip("motor not available in test env")

        import asyncio
        from pymongo import MongoClient

        MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
        DB_NAME = os.environ.get("DB_NAME", "test_database")
        mc = MongoClient(MONGO_URL)
        db = mc[DB_NAME]

        # Fresh worker (dedicated) to avoid overlap
        uname = f"TEST_min_{_run_id}"
        cu = session.post(f"{API}/users", headers=admin_headers, json={
            "username": uname, "password": "pw", "full_name": "TEST Minutes", "role": "worker",
        })
        assert cu.status_code == 200, cu.text
        wid = cu.json()["id"]

        # Reuse existing order
        oid = ctx["order_id"]

        # Insert 4 events with controlled timestamps
        base = datetime.now(timezone.utc).replace(hour=8, minute=0, second=0, microsecond=0)
        events = [
            ("START",    base + timedelta(minutes=0)),
            ("PAUSE",    base + timedelta(minutes=10)),
            ("RESUME",   base + timedelta(minutes=20)),
            ("COMPLETE", base + timedelta(minutes=35)),
        ]
        docs = []
        for t, ts in events:
            docs.append({
                "id": str(uuid.uuid4()),
                "work_order_id": oid,
                "worker_id": wid,
                "worker_username": uname,
                "worker_full_name": "TEST Minutes",
                "type": t,
                "reason": None,
                "photos_base64": [],
                "timestamp": ts,
                "ai_interpretation": None,
            })
        db.work_events.insert_many(docs)

        try:
            day = base.strftime("%Y-%m-%d")
            r = session.get(
                f"{API}/reports/daily?worker_ids={wid}&date={day}",
                headers=admin_headers, timeout=90,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert len(body["workers"]) == 1
            w = body["workers"][0]
            assert w["worker_id"] == wid
            assert w["events_count"] == 4
            assert w["minutes_worked"] == 25, f"expected 25, got {w['minutes_worked']}"
            assert body["total_minutes"] == 25
            assert body["orders_touched"] == 1
            # Order breakdown
            assert len(w["orders"]) == 1
            assert w["orders"][0]["minutes_worked"] == 25
            assert w["orders"][0]["events_count"] == 4
        finally:
            db.work_events.delete_many({"worker_id": wid})
            session.delete(f"{API}/users/{wid}", headers=admin_headers)
            mc.close()
