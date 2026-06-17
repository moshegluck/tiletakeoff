"""TileTakeoff backend API integration tests."""
import os
import io
import base64
import time
import requests
import pytest
from PIL import Image, ImageDraw

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://measure-tile.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

ADMIN_EMAIL = "admin@tiletakeoff.com"
ADMIN_PASSWORD = "Admin123!"


def _png_floorplan_bytes() -> bytes:
    """Generate a simple architectural floorplan-ish PNG (rooms + doors)."""
    img = Image.new("RGB", (800, 600), "white")
    d = ImageDraw.Draw(img)
    # Outer wall
    d.rectangle([40, 40, 760, 560], outline="black", width=6)
    # Interior partition
    d.line([(400, 40), (400, 320)], fill="black", width=5)
    d.line([(40, 320), (760, 320)], fill="black", width=5)
    # Doors (gaps)
    d.rectangle([260, 318, 320, 322], fill="white")
    d.rectangle([398, 180, 402, 240], fill="white")
    # Room labels
    d.text((180, 150), "KITCHEN", fill="black")
    d.text((550, 150), "BATH", fill="black")
    d.text((350, 430), "LIVING ROOM", fill="black")
    # Scale marker
    d.line([(60, 580), (160, 580)], fill="black", width=3)
    d.text((70, 565), "10 ft", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and "user" in data
    return data["token"]


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ===================== AUTH =====================
class TestAuth:
    def test_register_creates_workspace_and_admin(self):
        ts = int(time.time() * 1000)
        email = f"TEST_user_{ts}@example.com"
        r = requests.post(f"{API}/auth/register", json={
            "name": "TEST User", "email": email, "password": "TestPass123!",
            "company_name": "TEST Co"
        }, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "token" in data
        u = data["user"]
        assert u["role"] == "admin"
        assert u["workspace_id"]

        token = data["token"]
        # Starter tiles should be seeded
        rt = requests.get(f"{API}/tiles", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        assert rt.status_code == 200
        assert len(rt.json()) == 4

    def test_login_admin(self, admin_token):
        assert isinstance(admin_token, str) and len(admin_token) > 20

    def test_me_with_bearer(self, admin_headers):
        r = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        u = r.json()
        assert u["email"] == ADMIN_EMAIL
        assert u["role"] == "admin"

    def test_login_invalid(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"}, timeout=30)
        assert r.status_code == 401

    def test_me_no_token(self):
        r = requests.get(f"{API}/auth/me", timeout=30)
        assert r.status_code == 401


# ===================== PROJECTS =====================
class TestProjects:
    def test_create_list_get_delete(self, admin_headers):
        r = requests.post(f"{API}/projects", headers=admin_headers,
                          json={"name": "TEST_Project_1", "client": "ACME"}, timeout=30)
        assert r.status_code == 200, r.text
        pid = r.json()["id"]

        rl = requests.get(f"{API}/projects", headers=admin_headers, timeout=30)
        assert rl.status_code == 200
        proj = next((p for p in rl.json() if p["id"] == pid), None)
        assert proj is not None
        assert "drawing_count" in proj and "takeoff_count" in proj

        rg = requests.get(f"{API}/projects/{pid}", headers=admin_headers, timeout=30)
        assert rg.status_code == 200
        body = rg.json()
        assert body["project"]["id"] == pid
        assert "drawings" in body and "takeoffs" in body

        rd = requests.delete(f"{API}/projects/{pid}", headers=admin_headers, timeout=30)
        assert rd.status_code == 200

    def test_workspace_isolation(self):
        # Register a fresh user (different workspace)
        ts = int(time.time() * 1000)
        email = f"TEST_iso_{ts}@example.com"
        r = requests.post(f"{API}/auth/register", json={
            "name": "Iso", "email": email, "password": "IsoPass123!", "company_name": "Iso"
        }, timeout=30).json()
        tk = r["token"]
        rh = {"Authorization": f"Bearer {tk}"}
        # Create a project in own workspace
        rp = requests.post(f"{API}/projects", headers=rh, json={"name": "TEST_iso_proj"}, timeout=30)
        my_pid = rp.json()["id"]
        # Login as admin - should NOT see this project in list
        admin_login = requests.post(f"{API}/auth/login",
                                    json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json()
        admin_h = {"Authorization": f"Bearer {admin_login['token']}"}
        admin_list = requests.get(f"{API}/projects", headers=admin_h, timeout=30).json()
        assert all(p["id"] != my_pid for p in admin_list)
        # Admin GET on the foreign project should 404
        rg = requests.get(f"{API}/projects/{my_pid}", headers=admin_h, timeout=30)
        assert rg.status_code == 404


# ===================== TILES =====================
class TestTiles:
    def test_list_seeded(self, admin_headers):
        r = requests.get(f"{API}/tiles", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert len(r.json()) >= 4

    def test_crud_tile(self, admin_headers):
        r = requests.post(f"{API}/tiles", headers=admin_headers,
                          json={"name": "TEST_Tile_X", "width": 12, "height": 12,
                                "price_per_sqft": 3.5, "waste_factor": 0.10}, timeout=30)
        assert r.status_code == 200, r.text
        tid = r.json()["id"]
        assert r.json()["name"] == "TEST_Tile_X"

        ru = requests.put(f"{API}/tiles/{tid}", headers=admin_headers,
                          json={"name": "TEST_Tile_X2", "width": 24, "height": 24,
                                "price_per_sqft": 5.0, "waste_factor": 0.15}, timeout=30)
        assert ru.status_code == 200
        assert ru.json()["name"] == "TEST_Tile_X2"

        rd = requests.delete(f"{API}/tiles/{tid}", headers=admin_headers, timeout=30)
        assert rd.status_code == 200


# ===================== DRAWINGS + CALIBRATION =====================
@pytest.fixture(scope="class")
def project_with_image(admin_token):
    h = {"Authorization": f"Bearer {admin_token}"}
    p = requests.post(f"{API}/projects", headers=h,
                      json={"name": "TEST_Draw_Project"}, timeout=30).json()
    pid = p["id"]
    files = {"file": ("plan.png", _png_floorplan_bytes(), "image/png")}
    r = requests.post(f"{API}/projects/{pid}/drawings", headers=h, files=files, timeout=120)
    assert r.status_code == 200, r.text
    d = r.json()
    return {"pid": pid, "did": d["id"], "drawing": d, "token": admin_token}


class TestDrawings:
    def test_upload_and_fetch_file(self, project_with_image):
        d = project_with_image
        h = {"Authorization": f"Bearer {d['token']}"}
        assert d["drawing"]["content_type"] == "image/png"
        rf = requests.get(f"{API}/drawings/{d['did']}/file?auth={d['token']}",
                          headers=h, timeout=60)
        assert rf.status_code == 200
        assert rf.headers.get("content-type", "").startswith("image/")
        assert len(rf.content) > 1000

    def test_calibrate(self, project_with_image):
        d = project_with_image
        h = {"Authorization": f"Bearer {d['token']}"}
        # 100 px == 10 ft  -> scale 0.1 ft/px
        r = requests.post(f"{API}/drawings/{d['did']}/calibrate", headers=h,
                          json={"pixel_length": 100, "real_length": 10, "unit": "ft"}, timeout=30)
        assert r.status_code == 200
        assert abs(r.json()["scale"] - 0.1) < 1e-9


# ===================== TAKEOFFS + CALC =====================
class TestTakeoffs:
    def test_create_get_update_and_compute(self, admin_headers, admin_token, project_with_image):
        pid = project_with_image["pid"]
        did = project_with_image["did"]
        # Calibrate first
        requests.post(f"{API}/drawings/{did}/calibrate", headers=admin_headers,
                      json={"pixel_length": 100, "real_length": 10, "unit": "ft"}, timeout=30)
        # Create takeoff
        r = requests.post(f"{API}/projects/{pid}/takeoffs", headers=admin_headers,
                          json={"name": "TEST_TK", "type": "floor", "drawing_id": did}, timeout=30)
        assert r.status_code == 200, r.text
        tkid = r.json()["id"]

        # Pick a tile
        tiles = requests.get(f"{API}/tiles", headers=admin_headers, timeout=30).json()
        tile_id = tiles[0]["id"]

        # GET takeoff
        rg = requests.get(f"{API}/takeoffs/{tkid}", headers=admin_headers, timeout=30)
        assert rg.status_code == 200
        assert "summary" in rg.json() and "drawing" in rg.json()

        # PUT measurements: 200x200 px square => 200*200*0.01 = 400 sqft
        meas = [{
            "id": "m_test1", "type": "area", "label": "Room",
            "points": [[100, 100], [300, 100], [300, 300], [100, 300]],
            "count": 1, "is_deduction": False, "tile_id": None,
            "raw_value": 0, "color": "#EA580C"
        }]
        ru = requests.put(f"{API}/takeoffs/{tkid}", headers=admin_headers,
                          json={"measurements": meas, "default_tile_id": tile_id}, timeout=30)
        assert ru.status_code == 200, ru.text
        s = ru.json()["summary"]
        assert s["calibrated"] is True
        assert abs(s["totals"]["net_area"] - 400.0) < 0.01
        assert s["totals"]["tiles_needed"] > 0
        assert s["totals"]["cost"] > 0


# ===================== AI ANALYZE =====================
class TestAI:
    def test_ai_analyze_image(self, admin_headers, admin_token, project_with_image):
        pid = project_with_image["pid"]
        did = project_with_image["did"]
        tk = requests.post(f"{API}/projects/{pid}/takeoffs", headers=admin_headers,
                           json={"name": "TEST_AI_TK", "type": "floor", "drawing_id": did}, timeout=30).json()
        r = requests.post(f"{API}/takeoffs/{tk['id']}/ai-analyze", headers=admin_headers, timeout=180)
        assert r.status_code == 200, f"AI failed: {r.status_code} {r.text}"
        d = r.json()
        assert "regions" in d and "openings" in d and "recommended_waste_pct" in d and "summary" in d
        assert isinstance(d["regions"], list)

    def test_ai_no_drawing_400(self, admin_headers):
        # Create project + takeoff w/o drawing
        proj = requests.post(f"{API}/projects", headers=admin_headers,
                             json={"name": "TEST_AI_NoDraw"}, timeout=30).json()
        tk = requests.post(f"{API}/projects/{proj['id']}/takeoffs", headers=admin_headers,
                           json={"name": "tk", "type": "floor"}, timeout=30).json()
        r = requests.post(f"{API}/takeoffs/{tk['id']}/ai-analyze", headers=admin_headers, timeout=60)
        assert r.status_code == 400

    def test_ai_pdf_400(self, admin_headers):
        # Upload a PDF and attempt AI
        proj = requests.post(f"{API}/projects", headers=admin_headers,
                             json={"name": "TEST_AI_PDF"}, timeout=30).json()
        pdf_bytes = b"%PDF-1.4\n%fake pdf\n%%EOF"
        files = {"file": ("x.pdf", pdf_bytes, "application/pdf")}
        d = requests.post(f"{API}/projects/{proj['id']}/drawings", headers=admin_headers,
                          files=files, timeout=60).json()
        tk = requests.post(f"{API}/projects/{proj['id']}/takeoffs", headers=admin_headers,
                           json={"name": "tk", "type": "floor", "drawing_id": d["id"]}, timeout=30).json()
        r = requests.post(f"{API}/takeoffs/{tk['id']}/ai-analyze", headers=admin_headers, timeout=60)
        assert r.status_code == 400


# ===================== EXPORTS =====================
class TestExports:
    def _setup(self, admin_headers):
        proj = requests.post(f"{API}/projects", headers=admin_headers,
                             json={"name": "TEST_Export"}, timeout=30).json()
        files = {"file": ("plan.png", _png_floorplan_bytes(), "image/png")}
        d = requests.post(f"{API}/projects/{proj['id']}/drawings", headers=admin_headers,
                          files=files, timeout=60).json()
        requests.post(f"{API}/drawings/{d['id']}/calibrate", headers=admin_headers,
                      json={"pixel_length": 100, "real_length": 10, "unit": "ft"}, timeout=30)
        tk = requests.post(f"{API}/projects/{proj['id']}/takeoffs", headers=admin_headers,
                           json={"name": "TEST_ExpTK", "type": "floor", "drawing_id": d["id"]}, timeout=30).json()
        tiles = requests.get(f"{API}/tiles", headers=admin_headers, timeout=30).json()
        meas = [{"id": "m1", "type": "area", "points": [[0, 0], [200, 0], [200, 200], [0, 200]],
                 "count": 1, "is_deduction": False, "raw_value": 0, "color": "#000"}]
        requests.put(f"{API}/takeoffs/{tk['id']}", headers=admin_headers,
                     json={"measurements": meas, "default_tile_id": tiles[0]["id"]}, timeout=30)
        return tk["id"]

    def test_exports(self, admin_headers):
        tkid = self._setup(admin_headers)
        for fmt, expected_ct in [("csv", "text/csv"),
                                  ("xlsx", "spreadsheet"),
                                  ("pdf", "application/pdf")]:
            r = requests.get(f"{API}/takeoffs/{tkid}/export/{fmt}", headers=admin_headers, timeout=60)
            assert r.status_code == 200, f"{fmt} failed: {r.status_code} {r.text[:200]}"
            ct = r.headers.get("content-type", "")
            assert expected_ct in ct, f"{fmt} unexpected content-type: {ct}"
            assert len(r.content) > 50


# ===================== EMAIL =====================
class TestEmail:
    def test_email_not_configured(self, admin_headers):
        proj = requests.post(f"{API}/projects", headers=admin_headers,
                             json={"name": "TEST_Email"}, timeout=30).json()
        tk = requests.post(f"{API}/projects/{proj['id']}/takeoffs", headers=admin_headers,
                           json={"name": "tk", "type": "floor"}, timeout=30).json()
        r = requests.post(f"{API}/takeoffs/{tk['id']}/email", headers=admin_headers,
                          json={"recipient_email": "x@y.com"}, timeout=30)
        assert r.status_code == 503


# ===================== RBAC =====================
class TestRBAC:
    @pytest.fixture(scope="class")
    def viewer_and_estimator(self):
        # Login as admin (fresh)
        admin = requests.post(f"{API}/auth/login",
                              json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json()
        h = {"Authorization": f"Bearer {admin['token']}"}
        ts = int(time.time() * 1000)
        v_email = f"TEST_viewer_{ts}@x.com"
        e_email = f"TEST_estim_{ts}@x.com"
        rv = requests.post(f"{API}/workspace/members", headers=h,
                           json={"name": "Vw", "email": v_email,
                                 "password": "Pass123!", "role": "viewer"}, timeout=30)
        assert rv.status_code == 200, rv.text
        re_ = requests.post(f"{API}/workspace/members", headers=h,
                            json={"name": "Es", "email": e_email,
                                  "password": "Pass123!", "role": "estimator"}, timeout=30)
        assert re_.status_code == 200, re_.text
        v_tok = requests.post(f"{API}/auth/login",
                              json={"email": v_email, "password": "Pass123!"}).json()["token"]
        e_tok = requests.post(f"{API}/auth/login",
                              json={"email": e_email, "password": "Pass123!"}).json()["token"]
        return {"viewer": v_tok, "estimator": e_tok}

    def test_viewer_blocked_from_create_project(self, viewer_and_estimator):
        h = {"Authorization": f"Bearer {viewer_and_estimator['viewer']}"}
        r = requests.post(f"{API}/projects", headers=h, json={"name": "X"}, timeout=30)
        assert r.status_code == 403

    def test_viewer_blocked_from_create_tile(self, viewer_and_estimator):
        h = {"Authorization": f"Bearer {viewer_and_estimator['viewer']}"}
        r = requests.post(f"{API}/tiles", headers=h, json={"name": "X"}, timeout=30)
        assert r.status_code == 403

    def test_estimator_allowed_create_project(self, viewer_and_estimator):
        h = {"Authorization": f"Bearer {viewer_and_estimator['estimator']}"}
        r = requests.post(f"{API}/projects", headers=h,
                          json={"name": "TEST_estim_proj"}, timeout=30)
        assert r.status_code == 200

    def test_viewer_cannot_invite(self, viewer_and_estimator):
        h = {"Authorization": f"Bearer {viewer_and_estimator['viewer']}"}
        r = requests.post(f"{API}/workspace/members", headers=h,
                          json={"name": "Y", "email": f"TEST_x_{int(time.time())}@x.com",
                                "password": "Pass123!", "role": "viewer"}, timeout=30)
        assert r.status_code == 403
