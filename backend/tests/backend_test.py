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
    # 1x1 px JPEG: basta a soddisfare la foto del libretto nei test
    LIBRETTO_FINTO = ("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNCgsL"
                      "DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAAB"
                      "AAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oA"
                      "DAMBAAIRAxEAPwCdABmX/9k=")

    def _post_event(self, session, headers, order_id, etype, reason=None, km=None,
                    km_deferred_reason=None, minutes_effective=None, libretto=True):
        payload = {"type": etype}
        if etype == "START" and libretto:
            payload["libretto_base64"] = self.LIBRETTO_FINTO
        if reason:
            payload["reason"] = reason
        if km:
            payload["km"] = km
        if km_deferred_reason:
            payload["km_deferred_reason"] = km_deferred_reason
        if minutes_effective is not None:
            payload["minutes_effective"] = minutes_effective
        return session.post(f"{API}/work-orders/{order_id}/events", headers=headers, json=payload)

    def test_start_senza_libretto_rifiutato(self, session, state):
        """Dopo i km serve la foto del libretto: senza, il lavoro non parte."""
        r = self._post_event(session, state["worker_headers"], state["order_id"], "START",
                             km="154000", libretto=False)
        assert r.status_code == 400, r.text
        assert "libretto" in r.text.lower()

    def test_start_senza_km_e_senza_motivo_rifiutato(self, session, state):
        """I km si chiedono all'inizio: o il numero, o il perché non si può leggerlo."""
        r = self._post_event(session, state["worker_headers"], state["order_id"], "START")
        assert r.status_code == 400, r.text

    def test_start_event(self, session, state):
        r = self._post_event(session, state["worker_headers"], state["order_id"], "START", km="154000")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["type"] == "START"
        assert body["km"] == "154000"
        # verify status
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["status"] == "in_progress"
        # i km finiscono anche nella scheda tecnica
        assert r2.json()["scheda_tecnica"]["km"] == "154000"
        # e la foto del libretto entra nell'archivio della commessa, marcata
        foto = session.get(f"{API}/work-orders/{state['order_id']}/photos",
                           headers=state["worker_headers"]).json()
        assert any(f.get("kind") == "libretto" for f in foto), foto

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

    def test_ore_proposte(self, session, state):
        """Lo sportello propone sempre un numero, anche se l'AI non risponde."""
        r = session.get(f"{API}/work-orders/{state['order_id']}/ore-proposte",
                        headers=state["worker_headers"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body["minuti_proposti"], int)
        assert body["fonte"] in ("note", "timbri", "errore")

    def test_complete_senza_ore_rifiutato(self, session, state):
        """Le ore in fattura le conferma il meccanico: senza, non si chiude."""
        r = self._post_event(session, state["worker_headers"], state["order_id"], "COMPLETE",
                             reason="Lavoro finito")
        assert r.status_code == 400, r.text

    def test_complete_event(self, session, state):
        """Km già dati su START: alla chiusura non si richiedono. Le ore sì."""
        r = self._post_event(session, state["worker_headers"], state["order_id"], "COMPLETE",
                             reason="Lavoro finito", minutes_effective=135)
        assert r.status_code == 200, r.text
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["status"] == "completed"
        assert r2.json()["minutes_effective"] == 135, "le ore confermate finiscono in fattura"

    def test_correzione_km(self, session, state):
        """Km sbagliati: si correggono con un'osservazione, senza cambiare stato."""
        r = self._post_event(session, state["worker_headers"], state["order_id"], "KM", km="155000")
        assert r.status_code == 400, "senza motivo la correzione va rifiutata"

        r = self._post_event(session, state["worker_headers"], state["order_id"], "KM",
                             km="155000", reason="Avevo letto male il contachilometri")
        assert r.status_code == 200, r.text
        r2 = session.get(f"{API}/work-orders/{state['order_id']}", headers=state["worker_headers"])
        assert r2.json()["scheda_tecnica"]["km"] == "155000"
        assert r2.json()["status"] == "completed", "la correzione non deve cambiare lo stato"

    def test_list_events_ordered(self, session, state):
        r = session.get(f"{API}/work-orders/{state['order_id']}/events", headers=state["worker_headers"])
        assert r.status_code == 200
        events = r.json()
        types = [e["type"] for e in events]
        assert types == ["START", "PAUSE", "RESUME", "COMPLETE", "KM"], types


class TestPlanning:
    """Il titolare tocca un'auto del planning e la assegna: nasce la commessa.
    Se poi arriva il documento STAR per quella targa, si aggancia invece di duplicare."""

    OMNIUS_KEY = os.environ.get("OMNIUS_KEY", "")
    APP = {
        "giorno": "2026-08-03", "ora": "09:00", "ora_fine": "11:00", "ponte": "PONTE2",
        "targa": "TESTPL01AA", "cliente": "TEST Cliente Planning",
        "veicolo": "FORD Fiesta", "nota": "Spia avaria accesa, controllare carburazione",
    }

    def _planning_snapshot(self, session):
        if not self.OMNIUS_KEY:
            pytest.skip("OMNIUS_KEY non configurata: salto le prove sul planning")
        r = session.post(f"{API}/v1/omnius/planning",
                         headers={"X-Omnius-Key": self.OMNIUS_KEY, "Content-Type": "application/json"},
                         json={"aggiornato": "2026-08-01T20:00:00", "giorni_coperti": 7,
                               "appuntamenti": [self.APP]})
        assert r.status_code == 200, r.text

    def test_appuntamento_senza_meccanico_rifiutato(self, session, admin_headers, state):
        self._planning_snapshot(session)
        r = session.post(f"{API}/planning/crea-commessa", headers=admin_headers,
                         json={**self.APP, "assigned_worker_ids": []})
        assert r.status_code == 400, r.text

    def test_crea_commessa_dal_planning(self, session, admin_headers, state):
        r = session.post(f"{API}/planning/crea-commessa", headers=admin_headers,
                         json={**self.APP, "assigned_worker_ids": [state["worker_id"]]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["gia_esistente"] is False
        wo = body["work_order"]
        assert wo["plate"] == self.APP["targa"]
        assert wo["customer"] == self.APP["cliente"]
        assert wo["vehicle"] == self.APP["veicolo"]
        assert wo["description"] == self.APP["nota"]
        assert wo["status"] == "open", "creata dal titolare: aperta, non da approvare"
        assert state["worker_id"] in wo["assigned_worker_ids"]
        assert "PONTE2" in (wo["scheda_tecnica"].get("note") or ""), "l'appuntamento resta scritto nella scheda"
        state["planning_order_id"] = wo["id"]

    def test_secondo_click_non_duplica(self, session, admin_headers, state):
        r = session.post(f"{API}/planning/crea-commessa", headers=admin_headers,
                         json={**self.APP, "assigned_worker_ids": [state["worker_id"]]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["gia_esistente"] is True
        assert body["work_order"]["id"] == state["planning_order_id"]

    def test_planning_mostra_gia_smistata(self, session, admin_headers, state):
        r = session.get(f"{API}/planning", headers=admin_headers)
        assert r.status_code == 200
        app = [a for a in r.json()["appuntamenti"] if a["targa"] == self.APP["targa"]][0]
        assert app["commessa_id"] == state["planning_order_id"]
        assert app["assegnata_a"], "deve dire a chi è assegnata"

    def test_documento_star_si_aggancia(self, session, admin_headers, state):
        """La prova che conta: STAR non deve creare una seconda commessa per la stessa auto."""
        r = session.post(f"{API}/v1/omnius/commesse",
                         headers={"X-Omnius-Key": self.OMNIUS_KEY, "Content-Type": "application/json"},
                         json={"star_doc_id": f"STAR-TEST-{_run_id}", "plate": self.APP["targa"],
                               "customer": self.APP["cliente"], "vehicle": self.APP["veicolo"],
                               "note": "FILTRO OLIO; FILTRO ARIA"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["action"] == "adopted", f"atteso aggancio, ricevuto {body['action']}"
        assert body["work_order"]["id"] == state["planning_order_id"], "deve essere LA STESSA commessa"

        # una sola commessa per quella targa, e ora è agganciata a STAR
        tutte = session.get(f"{API}/work-orders", headers=admin_headers).json()
        mie = [o for o in tutte if o["plate"] == self.APP["targa"]]
        assert len(mie) == 1, f"doppione: {len(mie)} commesse per la stessa auto"


class TestKmRimandati:
    """Auto già sul ponte: il meccanico rimanda i km alla chiusura, spiegando il perché."""

    @pytest.fixture(scope="class")
    def order_id(self, session, admin_headers, state):
        r = session.post(f"{API}/work-orders", headers=admin_headers, json={
            "plate": "TEST-KM999ZZ",
            "customer": "TEST Cliente KM",
            "vehicle": "Fiat Punto",
            "description": "Auto arrivata sul ponte",
            "assigned_worker_ids": [state["worker_id"]],
        })
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def test_start_con_rinvio(self, session, state, order_id):
        r = session.post(f"{API}/work-orders/{order_id}/events", headers=state["worker_headers"],
                         json={"type": "START", "km_deferred_reason": "auto già sul ponte",
                               "libretto_base64": TestEvents.LIBRETTO_FINTO})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["km"] is None
        assert body["km_deferred_reason"] == "auto già sul ponte"

    def test_complete_senza_km_rifiutato(self, session, state, order_id):
        r = session.post(f"{API}/work-orders/{order_id}/events", headers=state["worker_headers"],
                         json={"type": "COMPLETE", "reason": "finito", "minutes_effective": 90})
        assert r.status_code == 400, "chi ha rimandato i km deve darli alla chiusura"

    def test_complete_con_km(self, session, state, order_id):
        r = session.post(f"{API}/work-orders/{order_id}/events", headers=state["worker_headers"],
                         json={"type": "COMPLETE", "reason": "finito", "km": "98000", "minutes_effective": 90})
        assert r.status_code == 200, r.text
        r2 = session.get(f"{API}/work-orders/{order_id}", headers=state["worker_headers"])
        assert r2.json()["scheda_tecnica"]["km"] == "98000"
        assert r2.json()["status"] == "completed"


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
