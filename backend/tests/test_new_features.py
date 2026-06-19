"""Tests for new TileTakeoff features: per-page calibration, revisions,
audit log, billing (Stripe), SKU CSV import, ai-region-status.
"""
import os
import io
import time
import requests
import pytest
from PIL import Image, ImageDraw

BASE = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE}/api"
ADMIN_EMAIL = "admin@tiletakeoff.com"
ADMIN_PASSWORD = "Admin123!"
EXISTING_TK = "tk_6c9ed25073494da9"


def _png_bytes() -> bytes:
    img = Image.new("RGB", (400, 300), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, 380, 280], outline="black", width=4)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ============= Per-page calibration =============
class TestPerPageCalibration:
    def test_calibrate_multiple_pages(self, admin_headers):
        # create project + upload an image as drawing (we just need a drawing record)
        proj = requests.post(f"{API}/projects", headers=admin_headers,
                             json={"name": "TEST_PerPage"}, timeout=30).json()
        files = {"file": ("plan.png", _png_bytes(), "image/png")}
        d = requests.post(f"{API}/projects/{proj['id']}/drawings",
                          headers=admin_headers, files=files, timeout=60).json()
        did = d["id"]

        # calibrate page 1
        r1 = requests.post(f"{API}/drawings/{did}/calibrate", headers=admin_headers,
                           json={"pixel_length": 100, "real_length": 10, "unit": "ft", "page": 1},
                           timeout=30)
        assert r1.status_code == 200, r1.text
        assert r1.json()["page"] == 1
        assert abs(r1.json()["scale"] - 0.1) < 1e-9

        # calibrate page 2 with different scale
        r2 = requests.post(f"{API}/drawings/{did}/calibrate", headers=admin_headers,
                           json={"pixel_length": 200, "real_length": 10, "unit": "ft", "page": 2},
                           timeout=30)
        assert r2.status_code == 200, r2.text
        assert r2.json()["page"] == 2
        assert abs(r2.json()["scale"] - 0.05) < 1e-9

        # Verify both calibrations stored on drawing via project GET
        # (drawings list comes back in project view)
        prj = requests.get(f"{API}/projects/{proj['id']}", headers=admin_headers, timeout=30).json()
        drawing = next(dr for dr in prj["drawings"] if dr["id"] == did)
        cals = drawing.get("calibrations", {})
        assert "1" in cals and "2" in cals
        assert abs(cals["1"]["scale"] - 0.1) < 1e-9
        assert abs(cals["2"]["scale"] - 0.05) < 1e-9

    def test_existing_takeoff_page1_calibrated(self, admin_headers):
        """Takeoff tk_6c9ed25073494da9 should have its drawing's page 1 calibrated already."""
        r = requests.get(f"{API}/takeoffs/{EXISTING_TK}", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        drawing = body.get("drawing") or {}
        cals = drawing.get("calibrations") or {}
        # page 1 must be calibrated
        page1 = cals.get("1") or cals.get(1) or drawing.get("calibration")
        assert page1 is not None, f"Expected page1 calibration; got cals={cals}"
        assert page1.get("scale") is not None


# ============= Revisions =============
class TestRevisions:
    def test_snapshot_list_restore(self, admin_headers):
        # snapshot existing takeoff
        rs = requests.post(f"{API}/takeoffs/{EXISTING_TK}/snapshot", headers=admin_headers,
                           json={"label": "TEST_snap_" + str(int(time.time()))}, timeout=30)
        assert rs.status_code == 200, rs.text
        rev = rs.json()
        assert rev.get("id", "").startswith("rev_")
        assert "totals" in rev
        assert rev.get("label", "").startswith("TEST_snap_")
        rev_id = rev["id"]

        # list revisions
        rl = requests.get(f"{API}/takeoffs/{EXISTING_TK}/revisions", headers=admin_headers, timeout=30)
        assert rl.status_code == 200
        revs = rl.json()["revisions"]
        assert any(r["id"] == rev_id for r in revs)
        # measurements should be excluded from list
        for r in revs:
            assert "measurements" not in r

        # restore revision
        rr = requests.post(f"{API}/takeoffs/{EXISTING_TK}/revisions/{rev_id}/restore",
                           headers=admin_headers, timeout=30)
        assert rr.status_code == 200, rr.text
        body = rr.json()
        assert "takeoff" in body and "summary" in body


# ============= Audit log =============
class TestAuditLog:
    def test_audit_list(self, admin_headers):
        r = requests.get(f"{API}/audit", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "logs" in data
        assert isinstance(data["logs"], list)
        # After snapshot test runs there should be at least one audit entry
        # but order isn't guaranteed across files; just check structure
        if data["logs"]:
            log = data["logs"][0]
            for k in ["action", "created_at", "user_name", "workspace_id"]:
                assert k in log, f"missing key {k} in log: {log}"

    def test_audit_records_snapshot(self, admin_headers):
        before = requests.get(f"{API}/audit", headers=admin_headers, timeout=30).json()["logs"]
        # do a snapshot
        rs = requests.post(f"{API}/takeoffs/{EXISTING_TK}/snapshot", headers=admin_headers,
                           json={"label": "TEST_audit_snap"}, timeout=30)
        assert rs.status_code == 200
        after = requests.get(f"{API}/audit", headers=admin_headers, timeout=30).json()["logs"]
        assert len(after) > len(before), "audit log did not grow after snapshot"
        # newest entry should be a snapshot entry
        assert any("snapshot" in (l.get("action") or "").lower() for l in after[:5])


# ============= Billing (Stripe) =============
class TestBilling:
    def test_billing_me(self, admin_headers):
        r = requests.get(f"{API}/billing/me", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "plan" in d and "plans" in d
        assert d["plan"] in ("free", "pro", "team")
        plans = d["plans"]
        for pid in ["free", "pro", "team"]:
            assert pid in plans
            assert "price" in plans[pid] and "name" in plans[pid]

    def test_billing_checkout_creates_session(self, admin_headers):
        r = requests.post(f"{API}/billing/checkout", headers=admin_headers,
                          json={"plan_id": "pro", "origin_url": BASE}, timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "url" in d and "session_id" in d
        assert "stripe.com" in d["url"], f"unexpected url: {d['url']}"
        assert d["session_id"].startswith("cs_")

    def test_billing_checkout_rejects_free(self, admin_headers):
        r = requests.post(f"{API}/billing/checkout", headers=admin_headers,
                          json={"plan_id": "free", "origin_url": BASE}, timeout=30)
        assert r.status_code == 400

    def test_billing_checkout_rejects_invalid_plan(self, admin_headers):
        r = requests.post(f"{API}/billing/checkout", headers=admin_headers,
                          json={"plan_id": "bogus", "origin_url": BASE}, timeout=30)
        assert r.status_code == 400


# ============= SKU CSV import =============
class TestSKUCSVImport:
    def test_import_with_sku(self, admin_headers):
        csv_text = (
            "name,sku,manufacturer,distributor,width,height,unit,finish,color,pattern,price_per_sqft\n"
            f"TEST_QA SKU Tile {int(time.time())},QA-1224,Daltile,ProSource,12,24,in,Matte,#7799bb,Grid,5.0\n"
        )
        files = {"file": ("tiles.csv", csv_text.encode("utf-8"), "text/csv")}
        r = requests.post(f"{API}/tiles/import", headers=admin_headers, files=files, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["imported"] == 1
        assert d["errors"] == []
        t = d["tiles"][0]
        assert t["sku"] == "QA-1224"
        assert t["manufacturer"] == "Daltile"
        assert t["distributor"] == "ProSource"
        assert abs(t["price_per_sqft"] - 5.0) < 1e-9
        assert t["width"] == 12 and t["height"] == 24

        # Verify it shows up in the catalog list with SKU
        lr = requests.get(f"{API}/tiles", headers=admin_headers, timeout=30).json()
        found = next((x for x in lr if x.get("sku") == "QA-1224"), None)
        assert found is not None, "imported tile not present in /tiles list"
        assert found["manufacturer"] == "Daltile"


# ============= AI region status =============
class TestAIRegionStatus:
    def test_region_status_404_when_no_suggestions(self, admin_headers):
        # Make a fresh takeoff with no AI suggestions
        proj = requests.post(f"{API}/projects", headers=admin_headers,
                             json={"name": "TEST_RegionStatus"}, timeout=30).json()
        tk = requests.post(f"{API}/projects/{proj['id']}/takeoffs", headers=admin_headers,
                           json={"name": "tk", "type": "floor"}, timeout=30).json()
        r = requests.post(f"{API}/takeoffs/{tk['id']}/ai-region-status",
                          headers=admin_headers,
                          json={"index": 0, "status": "accepted"}, timeout=30)
        assert r.status_code == 404

    def test_region_status_on_existing_takeoff(self, admin_headers):
        """If the existing demo takeoff has ai_suggestions, accept index 0."""
        tk = requests.get(f"{API}/takeoffs/{EXISTING_TK}", headers=admin_headers, timeout=30).json()
        ai = (tk.get("takeoff") or {}).get("ai_suggestions") or {}
        regions = ai.get("regions") or []
        if not regions:
            pytest.skip("Existing demo takeoff has no ai_suggestions.regions yet")
        r = requests.post(f"{API}/takeoffs/{EXISTING_TK}/ai-region-status",
                          headers=admin_headers,
                          json={"index": 0, "status": "accepted"}, timeout=30)
        assert r.status_code == 200
        assert r.json()["status"] == "accepted"
