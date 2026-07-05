"""
Tests for iteration 2: AI voice chat, vision plate OCR, whisper transcription.
Endpoints under test:
  - POST /api/vision/plate
  - POST /api/audio/transcribe
  - POST /api/work-orders/{id}/voice-turn
  - GET  /api/work-orders/{id}/conversation
Plus a small regression check on the previous iteration's critical endpoints.
"""
import io
import os
import time
import uuid
import base64
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL") or "https://car-bay-flow.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")

ADMIN_USER = "admin"
ADMIN_PASS = "admin123"

RUN_ID = uuid.uuid4().hex[:6]


# --------------- Fixtures ---------------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"username": ADMIN_USER, "password": ADMIN_PASS}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def worker(admin_h):
    username = f"TEST_wv_{RUN_ID}"
    r = requests.post(f"{BASE_URL}/api/users", headers=admin_h,
                      json={"username": username, "password": "worker123",
                            "full_name": "Test Voice Worker", "role": "worker"}, timeout=30)
    assert r.status_code == 200, r.text
    user = r.json()
    login = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"username": username, "password": "worker123"}, timeout=30)
    assert login.status_code == 200, login.text
    user["token"] = login.json()["token"]
    yield user
    requests.delete(f"{BASE_URL}/api/users/{user['id']}", headers=admin_h, timeout=30)


@pytest.fixture(scope="module")
def other_worker(admin_h):
    username = f"TEST_wv2_{RUN_ID}"
    r = requests.post(f"{BASE_URL}/api/users", headers=admin_h,
                      json={"username": username, "password": "w222",
                            "full_name": "Other Worker", "role": "worker"}, timeout=30)
    assert r.status_code == 200, r.text
    user = r.json()
    login = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"username": username, "password": "w222"}, timeout=30)
    user["token"] = login.json()["token"]
    yield user
    requests.delete(f"{BASE_URL}/api/users/{user['id']}", headers=admin_h, timeout=30)


@pytest.fixture(scope="module")
def order(admin_h, worker):
    r = requests.post(f"{BASE_URL}/api/work-orders", headers=admin_h,
                      json={"plate": f"TEST{RUN_ID}", "customer": "TEST Cliente",
                            "vehicle": "Fiat Panda", "description": "Tagliando + freni",
                            "assigned_worker_ids": [worker["id"]]}, timeout=30)
    assert r.status_code == 200, r.text
    o = r.json()
    yield o
    requests.delete(f"{BASE_URL}/api/work-orders/{o['id']}", headers=admin_h, timeout=30)


# --------------- Vision: plate OCR ---------------
class TestVisionPlate:
    def test_plate_ocr_non_plate_image_does_not_500(self, worker):
        # Tiny 1x1 red PNG → NOT a plate → API must return 200 with plate=null (not 500)
        tiny_png_b64 = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8"
            "z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
        )
        r = requests.post(
            f"{BASE_URL}/api/vision/plate",
            headers={"Authorization": f"Bearer {worker['token']}"},
            json={"image_base64": tiny_png_b64}, timeout=120,
        )
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert "plate" in data and "raw" in data
        # plate should be None or a valid string; must not crash
        assert data["plate"] is None or isinstance(data["plate"], str)

    def test_plate_ocr_requires_auth(self):
        r = requests.post(f"{BASE_URL}/api/vision/plate",
                          json={"image_base64": "AAAA"}, timeout=30)
        assert r.status_code == 401


# --------------- Audio transcribe ---------------
class TestAudioTranscribe:
    def test_transcribe_accepts_multipart(self, worker):
        # Feed a tiny fake wav; whisper will likely error, backend should return 500 (documented)
        # We only assert the endpoint *accepts* multipart (i.e. not 422)
        buf = io.BytesIO(b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00"
                         b"\x01\x00\x01\x00\x40\x1f\x00\x00\x80>\x00\x00\x02\x00\x10\x00"
                         b"data\x00\x00\x00\x00")
        files = {"file": ("test.wav", buf, "audio/wav")}
        r = requests.post(
            f"{BASE_URL}/api/audio/transcribe",
            headers={"Authorization": f"Bearer {worker['token']}"},
            files=files, timeout=60,
        )
        # Must NOT be 422 (bad multipart handling). 200 or 500 (whisper reject empty audio) both acceptable.
        assert r.status_code in (200, 500), f"unexpected {r.status_code}: {r.text[:300]}"
        if r.status_code == 200:
            assert "text" in r.json()

    def test_transcribe_requires_auth(self):
        r = requests.post(f"{BASE_URL}/api/audio/transcribe",
                          files={"file": ("x.wav", b"x", "audio/wav")}, timeout=15)
        assert r.status_code == 401


# --------------- Voice-turn + conversation ---------------
class TestVoiceTurn:
    def test_first_turn_populates_scheda(self, worker, order):
        r = requests.post(
            f"{BASE_URL}/api/work-orders/{order['id']}/voice-turn",
            headers={"Authorization": f"Bearer {worker['token']}", "Content-Type": "application/json"},
            json={"user_text": "Sto lavorando su una Fiat Panda 1.2 del 2015, 90mila km. Ho cambiato le pastiglie freno."},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("assistant_text"), "assistant_text vuoto"
        assert isinstance(data["assistant_text"], str) and len(data["assistant_text"]) > 3
        sc = data["scheda_tecnica"]
        # Marca / modello / anno present
        assert sc.get("marca") and "fiat" in sc["marca"].lower(), sc
        assert sc.get("modello") and "panda" in sc["modello"].lower(), sc
        assert sc.get("anno") and "2015" in sc["anno"], sc
        # 'pastiglie' must be captured somewhere (lavori_fatti or ricambi_necessari)
        joined = " ".join(sc.get("lavori_fatti", []) + sc.get("ricambi_necessari", [])).lower()
        assert "pastigli" in joined, f"pastiglie non trovate nella scheda: {sc}"

    def test_second_turn_merges_not_overwrites(self, worker, order):
        # Sanity: first turn must have run above (module-scoped order fixture)
        r = requests.post(
            f"{BASE_URL}/api/work-orders/{order['id']}/voice-turn",
            headers={"Authorization": f"Bearer {worker['token']}", "Content-Type": "application/json"},
            json={"user_text": "Devo ancora fare tagliando e cambiare olio motore"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        sc = r.json()["scheda_tecnica"]
        # marca/modello preserved from first turn
        assert sc.get("marca") and "fiat" in sc["marca"].lower(), sc
        assert sc.get("modello") and "panda" in sc["modello"].lower(), sc
        # something related to tagliando/olio ended up in lavori_da_fare
        da_fare = " ".join(sc.get("lavori_da_fare", [])).lower()
        assert ("tagliando" in da_fare) or ("olio" in da_fare), f"lavori_da_fare mancanti: {sc}"

    def test_get_conversation_returns_turns_and_scheda(self, worker, order):
        r = requests.get(
            f"{BASE_URL}/api/work-orders/{order['id']}/conversation",
            headers={"Authorization": f"Bearer {worker['token']}"}, timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["work_order_id"] == order["id"]
        assert isinstance(data["turns"], list)
        # After 2 voice-turns we expect 4 turns (2 user + 2 assistant)
        assert len(data["turns"]) >= 4, f"expected >=4 turns, got {len(data['turns'])}"
        assert data["scheda_tecnica"]["marca"]  # non-empty

    def test_other_worker_cannot_post_voice_turn(self, other_worker, order):
        r = requests.post(
            f"{BASE_URL}/api/work-orders/{order['id']}/voice-turn",
            headers={"Authorization": f"Bearer {other_worker['token']}", "Content-Type": "application/json"},
            json={"user_text": "hack"}, timeout=30,
        )
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"

    def test_other_worker_cannot_get_conversation(self, other_worker, order):
        r = requests.get(
            f"{BASE_URL}/api/work-orders/{order['id']}/conversation",
            headers={"Authorization": f"Bearer {other_worker['token']}"}, timeout=30,
        )
        assert r.status_code == 403

    def test_empty_text_400(self, worker, order):
        r = requests.post(
            f"{BASE_URL}/api/work-orders/{order['id']}/voice-turn",
            headers={"Authorization": f"Bearer {worker['token']}", "Content-Type": "application/json"},
            json={"user_text": "   "}, timeout=30,
        )
        assert r.status_code == 400

    def test_voice_turn_nonexistent_order_404(self, worker):
        r = requests.post(
            f"{BASE_URL}/api/work-orders/does-not-exist/voice-turn",
            headers={"Authorization": f"Bearer {worker['token']}", "Content-Type": "application/json"},
            json={"user_text": "ciao"}, timeout=30,
        )
        assert r.status_code in (403, 404)  # worker not assigned yields 403 too


# --------------- Regression on prev iteration ---------------
class TestRegression:
    def test_login_admin(self):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"username": ADMIN_USER, "password": ADMIN_PASS}, timeout=30)
        assert r.status_code == 200

    def test_users_list(self, admin_h):
        r = requests.get(f"{BASE_URL}/api/users", headers=admin_h, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_work_orders_list(self, admin_h):
        r = requests.get(f"{BASE_URL}/api/work-orders", headers=admin_h, timeout=30)
        assert r.status_code == 200

    def test_live_status(self, admin_h):
        r = requests.get(f"{BASE_URL}/api/workers/live-status", headers=admin_h, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_recent_events(self, admin_h):
        r = requests.get(f"{BASE_URL}/api/events/recent?limit=10", headers=admin_h, timeout=30)
        assert r.status_code == 200
