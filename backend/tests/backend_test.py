"""
Officina Meccanica - Backend API tests.
Covers: auth, users CRUD, work orders, events + AI interpretation,
live worker status, daily AI report, role-based authorization.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://car-bay-flow.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_USER = "admin"
ADMIN_PASS = "admin123"

# Unique test worker per run (avoid collisions)
_run_id = uuid.uuid4().hex[:8]
WORKER_USER = f"TEST_mario_{_run_id}"
WORKER_FULLNAME = "TEST Mario Rossi"
WORKER_PASS = "mario123"


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_token(session):
    r = session.post(f"{API}/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def state():
    return {}


# ---------- Auth ----------
class TestAuth:
    def test_login_success(self, session):
        r = session.post(f"{API}/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
        assert r.status_code == 200
        body = r.json()
        assert "token" in body and body["token"]
        assert body["user"]["username"] == ADMIN_USER
        assert body["user"]["role"] == "admin"

    def test_login_invalid(self, session):
        r = session.post(f"{API}/auth/login", json={"username": ADMIN_USER, "password": "wrong"})
        assert r.status_code == 401

    def test_me_with_valid_token(self, session, admin_headers):
        r = session.get(f"{API}/auth/me", headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["username"] == ADMIN_USER

    def test_me_without_token(self, session):
        r = session.get(f"{API}/auth/me")
        assert r.status_code == 401


# ---------- Users CRUD ----------
class TestUsers:
    def test_admin_can_create_worker(self, session, admin_headers, state):
        r = session.post(f"{API}/users", headers=admin_headers, json={
            "username": WORKER_USER,
            "password": WORKER_PASS,
            "full_name": WORKER_FULLNAME,
            "role": "worker",
        })
        assert r.status_code == 200, r.text
        u = r.json()
        assert u["username"] == WORKER_USER
        assert u["role"] == "worker"
        state["worker_id"] = u["id"]

    def test_worker_login(self, session, state):
        r = session.post(f"{API}/auth/login", json={"username": WORKER_USER, "password": WORKER_PASS})
        assert r.status_code == 200
        state["worker_token"] = r.json()["token"]
        state["worker_headers"] = {"Authorization": f"Bearer {state['worker_token']}", "Content-Type": "application/json"}

    def test_list_users_persists_worker(self, session, admin_headers, state):
        r = session.get(f"{API}/users", headers=admin_headers)
        assert r.status_code == 200
        ids = [u["id"] for u in r.json()]
        assert state["worker_id"] in ids

    def test_update_worker(self, session, admin_headers, state):
        r = session.put(f"{API}/users/{state['worker_id']}", headers=admin_headers,
                        json={"full_name": "TEST Mario Aggiornato"})
        assert r.status_code == 200
        assert r.json()["full_name"] == "TEST Mario Aggiornato"

    def test_worker_forbidden_on_users_list(self, session, state):
        r = session.get(f"{API}/users", headers=state["worker_headers"])
        assert r.status_code == 403

    def test_worker_forbidden_on_user_create(self, session, state):
        r = session.post(f"{API}/users", headers=state["worker_headers"], json={
            "username": "TEST_x", "password": "x", "full_name": "x", "role": "worker"
        })
        assert r.status_code == 403


# ---------- Work Orders ----------
class TestWorkOrders:
    def test_admin_can_create_order(self, session, admin_headers, state):
        payload = {
            "plate": "TEST-AB123CD",
            "customer": "TEST Cliente SRL",
            "vehicle": "Fiat Panda 1.2",
            "description": "Tagliando + freni",
            "assigned_worker_ids": [state["worker_id"]],
        }
        r = session.post(f"{API}/work-orders", headers=admin_headers, json=payload)
        assert r.status_code == 200, r.text
        o = r.json()
        assert o["plate"] == payload["plate"]
        assert o["status"] == "open"
        assert state["worker_id"] in o["assigned_worker_ids"]
        state["order_id"] = o["id"]

    def test_worker_sees_only_assigned(self, session, state):
        r = session.get(f"{API}/work-orders", headers=state["worker_headers"])
        assert r.status_code == 200
        orders = r.json()
        assert any(o["id"] == state["order_id"] for o in orders)
        # All orders returned must be assigned to worker
        for o in orders:
            assert state["worker_id"] in o["assigned_worker_ids"]

    def test_worker_forbidden_to_create_order(self, session, state):
        r = session.post(f"{API}/work-orders", headers=state["worker_headers"], json={
            "plate": "X", "customer": "Y", "vehicle": "Z", "description": "d", "assigned_worker_ids": []
        })
        assert r.status_code == 403


# ---------- Events + status transitions + AI ----------
class TestEvents:
    def _post_event(self, session, headers, order_id, etype, reason=None):
        payload = {"type": etype}
        if reason:
            payload["reason"] = reason
        return session.post(f"{API}/work-orders/{order_id}/events", headers=headers, json=payload)

    def test_start_event(self, session, state):
        r = self._post_event(session, state["worker_headers"], state["order_id"], "START")
        assert r.status_code == 200, r.text
        assert r.json()["type"] == "START"
        # verify status
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["status"] == "in_progress"

    def test_pause_event_has_ai_interpretation(self, session, state):
        r = self._post_event(session, state["worker_headers"], state["order_id"],
                             "PAUSE", reason="Manca il filtro olio, aspetto pezzo di ricambio")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["type"] == "PAUSE"
        assert body["reason"] is not None
        # AI interpretation should be populated (Claude Sonnet 4.5)
        assert body["ai_interpretation"] is not None and len(body["ai_interpretation"]) > 0, \
            f"AI interpretation missing: {body}"
        state["ai_interp"] = body["ai_interpretation"]
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["status"] == "paused"

    def test_resume_event(self, session, state):
        r = self._post_event(session, state["worker_headers"], state["order_id"], "RESUME")
        assert r.status_code == 200
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["status"] == "in_progress"

    def test_complete_event(self, session, state):
        r = self._post_event(session, state["worker_headers"], state["order_id"], "COMPLETE")
        assert r.status_code == 200
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["status"] == "completed"

    def test_list_events_ordered(self, session, state):
        r = session.get(f"{API}/work-orders/{state['order_id']}/events", headers=state["worker_headers"])
        assert r.status_code == 200
        events = r.json()
        types = [e["type"] for e in events]
        assert types == ["START", "PAUSE", "RESUME", "COMPLETE"], types


# ---------- Live status + Reports ----------
class TestLiveAndReports:
    def test_live_status_contains_worker(self, session, admin_headers, state):
        # Create a fresh order + start event so worker is 'working'
        payload = {
            "plate": "TEST-EF456GH",
            "customer": "TEST Cliente 2",
            "vehicle": "Alfa Giulia",
            "description": "Diagnosi motore",
            "assigned_worker_ids": [state["worker_id"]],
        }
        o = session.post(f"{API}/work-orders", headers=admin_headers, json=payload).json()
        state["order2_id"] = o["id"]
        session.post(f"{API}/work-orders/{o['id']}/events", headers=state["worker_headers"], json={"type": "START"})

        r = session.get(f"{API}/workers/live-status", headers=admin_headers)
        assert r.status_code == 200
        rows = r.json()
        me = next((w for w in rows if w["worker_id"] == state["worker_id"]), None)
        assert me is not None
        assert me["current_status"] == "working"
        assert me["minutes_since"] is not None

    def test_workers_forbidden_from_live_status(self, session, state):
        r = session.get(f"{API}/workers/live-status", headers=state["worker_headers"])
        assert r.status_code == 403

    def test_daily_report_ai(self, session, admin_headers):
        r = session.get(f"{API}/reports/daily", headers=admin_headers, timeout=90)
        assert r.status_code == 200
        body = r.json()
        # New schema
        for k in ("date", "filter_worker_ids", "workers", "total_events",
                  "total_minutes", "orders_touched", "narrative", "generated_at"):
            assert k in body, f"missing key {k} in {body}"
        assert isinstance(body["narrative"], str) and len(body["narrative"]) > 0
        assert isinstance(body["workers"], list)
        assert body["total_events"] >= 1

    def test_recent_events(self, session, admin_headers):
        r = session.get(f"{API}/events/recent?limit=20", headers=admin_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# ---------- Cleanup ----------
class TestZCleanup:
    def test_cleanup_orders_and_worker(self, session, admin_headers, state):
        for k in ("order_id", "order2_id"):
            oid = state.get(k)
            if oid:
                session.delete(f"{API}/work-orders/{oid}", headers=admin_headers)
        wid = state.get("worker_id")
        if wid:
            r = session.delete(f"{API}/users/{wid}", headers=admin_headers)
            assert r.status_code == 200
