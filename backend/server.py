"""TileTakeoff API server."""
import os
import asyncio
import base64
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, Response, UploadFile, File, Query, Header
from fastapi.responses import StreamingResponse
from starlette.middleware.cors import CORSMiddleware
import resend

from models import (db, now_iso, new_id, RegisterRequest, LoginRequest, InviteRequest,
                    ProjectIn, TileIn, CalibrationIn, TakeoffIn, TakeoffUpdate, AIRequest)
from auth import (hash_password, verify_password, create_access_token, set_auth_cookie,
                  clear_auth_cookie, get_current_user, require_role, create_user_with_workspace,
                  exchange_emergent_session, seed_admin, authenticate_token)
import storage
import ai_service
import calc
from emergentintegrations.payments.stripe.checkout import StripeCheckout, CheckoutSessionRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="TileTakeoff API")
api = APIRouter(prefix="/api")

resend.api_key = os.environ.get("RESEND_API_KEY", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")


async def current_user(request: Request) -> dict:
    return await get_current_user(request)


async def record_audit(user: dict, action: str, entity: str = "", detail: str = ""):
    """Best-effort audit trail entry."""
    try:
        await db.audit_logs.insert_one({
            "id": new_id("aud_"), "workspace_id": user.get("workspace_id"),
            "user_name": user.get("name") or user.get("email"), "user_id": user.get("id"),
            "action": action, "entity": entity, "detail": detail, "created_at": now_iso(),
        })
    except Exception as e:  # never let logging break the request
        logger.warning(f"audit log failed: {e}")


@api.get("/audit")
async def list_audit(user: dict = Depends(current_user)):
    require_role(user, "admin")
    await require_feature(user, "audit")
    logs = await db.audit_logs.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return {"logs": logs}


# ---------------- Billing (Stripe) ----------------
# Plans are defined server-side ONLY — never trust amounts from the client.
PLANS = {
    "free": {"name": "Free", "price": 0.0, "blurb": "1 project · core takeoff tools"},
    "pro": {"name": "Pro", "price": 29.0, "blurb": "Unlimited projects · AI takeoff · exports · email"},
    "team": {"name": "Team", "price": 99.0, "blurb": "Everything in Pro · multi-seat · audit log · priority"},
}

# Server-side feature gates per plan. max_* = None means unlimited.
PLAN_LIMITS = {
    "free": {"max_projects": 1, "max_members": 1, "ai": False, "exports": False, "email": False, "audit": False},
    "pro": {"max_projects": None, "max_members": 1, "ai": True, "exports": True, "email": True, "audit": False},
    "team": {"max_projects": None, "max_members": 10, "ai": True, "exports": True, "email": True, "audit": True},
}


async def ws_plan(user: dict) -> str:
    ws = await db.workspaces.find_one({"id": user["workspace_id"]}, {"_id": 0, "plan": 1})
    return (ws or {}).get("plan", "free")


async def require_feature(user: dict, feature: str):
    plan = await ws_plan(user)
    if not PLAN_LIMITS.get(plan, PLAN_LIMITS["free"]).get(feature):
        raise HTTPException(status_code=402, detail=f"Your {plan.title()} plan doesn't include this feature. Upgrade to unlock it.")
    return plan


def _stripe(request: Request) -> StripeCheckout:
    host_url = str(request.base_url)
    webhook_url = f"{host_url.rstrip('/')}/api/webhook/stripe"
    return StripeCheckout(api_key=os.environ.get("STRIPE_API_KEY", ""), webhook_url=webhook_url)


@api.get("/billing/me")
async def billing_me(user: dict = Depends(current_user)):
    ws = await db.workspaces.find_one({"id": user["workspace_id"]}, {"_id": 0})
    plan = (ws or {}).get("plan", "free")
    proj_count = await db.projects.count_documents({"workspace_id": user["workspace_id"], "is_deleted": {"$ne": True}})
    member_count = await db.users.count_documents({"workspace_id": user["workspace_id"]})
    return {"plan": plan, "plan_status": (ws or {}).get("plan_status"), "plans": PLANS,
            "limits": PLAN_LIMITS, "usage": {"projects": proj_count, "members": member_count}}


@api.post("/billing/checkout")
async def billing_checkout(request: Request, user: dict = Depends(current_user)):
    require_role(user, "admin")
    body = await request.json()
    plan_id = body.get("plan_id")
    origin = (body.get("origin_url") or "").rstrip("/")
    if plan_id not in PLANS or plan_id == "free":
        raise HTTPException(status_code=400, detail="Invalid plan")
    if not origin:
        raise HTTPException(status_code=400, detail="origin_url required")
    amount = float(PLANS[plan_id]["price"])  # server-side amount
    metadata = {"workspace_id": user["workspace_id"], "plan_id": plan_id, "user_id": user.get("id", "")}
    success_url = f"{origin}/billing?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}/billing"
    stripe = _stripe(request)
    req = CheckoutSessionRequest(amount=amount, currency="usd", success_url=success_url, cancel_url=cancel_url, metadata=metadata)
    session = await stripe.create_checkout_session(req)
    await db.payment_transactions.insert_one({
        "id": new_id("pay_"), "session_id": session.session_id, "workspace_id": user["workspace_id"],
        "user_id": user.get("id"), "plan_id": plan_id, "amount": amount, "currency": "usd",
        "payment_status": "initiated", "status": "open", "metadata": metadata, "created_at": now_iso(),
    })
    return {"url": session.url, "session_id": session.session_id}


async def _apply_paid(session_id: str):
    """Idempotently mark a transaction paid and upgrade the workspace plan."""
    txn = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not txn or txn.get("payment_status") == "paid":
        return txn
    await db.payment_transactions.update_one({"session_id": session_id}, {"$set": {"payment_status": "paid", "status": "complete", "paid_at": now_iso()}})
    await db.workspaces.update_one({"id": txn["workspace_id"]}, {"$set": {"plan": txn["plan_id"], "plan_status": "active"}})
    return txn


@api.get("/billing/status/{session_id}")
async def billing_status(session_id: str, request: Request, user: dict = Depends(current_user)):
    stripe = _stripe(request)
    cs = await stripe.get_checkout_status(session_id)
    update = {"payment_status": cs.payment_status, "status": cs.status}
    await db.payment_transactions.update_one({"session_id": session_id}, {"$set": update})
    if cs.payment_status == "paid":
        await _apply_paid(session_id)
    return {"status": cs.status, "payment_status": cs.payment_status, "amount_total": cs.amount_total, "currency": cs.currency}


@api.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    stripe = _stripe(request)
    body = await request.body()
    sig = request.headers.get("Stripe-Signature")
    try:
        evt = await stripe.handle_webhook(body, sig)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Webhook error: {e}")
    if evt.payment_status == "paid" and evt.session_id:
        await _apply_paid(evt.session_id)
    return {"received": True}


# ---------------- Auth ----------------
@api.post("/auth/register")
async def register(body: RegisterRequest, response: Response):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    user = await create_user_with_workspace(body.name, email, hash_password(body.password), body.company_name)
    token = create_access_token(user["id"], email)
    set_auth_cookie(response, token)
    return {"user": user, "token": token}


@api.post("/auth/login")
async def login(body: LoginRequest, response: Response):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not user.get("password_hash") or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user["id"], email)
    set_auth_cookie(response, token)
    user.pop("password_hash", None)
    user.pop("_id", None)
    return {"user": user, "token": token}


@api.post("/auth/google-session")
async def google_session(request: Request, response: Response):
    body = await request.json()
    session_id = body.get("session_id")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    result = await exchange_emergent_session(session_id)
    response.set_cookie("session_token", result["session_token"], httponly=True, secure=True,
                        samesite="none", max_age=604800, path="/")
    return {"user": result["user"], "token": result["session_token"]}


@api.get("/auth/me")
async def me(user: dict = Depends(current_user)):
    return user


@api.post("/auth/logout")
async def logout(response: Response, user: dict = Depends(current_user)):
    clear_auth_cookie(response)
    return {"ok": True}


# ---------------- Workspace / Members ----------------
@api.get("/workspace")
async def get_workspace(user: dict = Depends(current_user)):
    ws = await db.workspaces.find_one({"id": user["workspace_id"]}, {"_id": 0})
    members = await db.users.find({"workspace_id": user["workspace_id"]},
                                  {"_id": 0, "password_hash": 0}).to_list(200)
    return {"workspace": ws, "members": members}


@api.post("/workspace/members")
async def invite_member(body: InviteRequest, user: dict = Depends(current_user)):
    require_role(user, "admin")
    plan = await ws_plan(user)
    max_m = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"]).get("max_members")
    if max_m is not None:
        count = await db.users.count_documents({"workspace_id": user["workspace_id"]})
        if count >= max_m:
            raise HTTPException(status_code=402, detail=f"The {plan.title()} plan allows {max_m} seat(s). Upgrade to Team for more.")
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already in use")
    if body.role not in ("admin", "estimator", "viewer"):
        raise HTTPException(status_code=400, detail="Invalid role")
    doc = {"id": new_id("user_"), "name": body.name, "email": email,
           "password_hash": hash_password(body.password), "role": body.role,
           "workspace_id": user["workspace_id"], "picture": "", "auth_provider": "jwt",
           "created_at": now_iso()}
    await db.users.insert_one(doc)
    doc.pop("password_hash", None)
    doc.pop("_id", None)
    return doc


# ---------------- Projects ----------------
@api.get("/projects")
async def list_projects(user: dict = Depends(current_user)):
    projects = await db.projects.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
    ids = [p["id"] for p in projects]
    async def _counts(coll):
        rows = await coll.aggregate([{"$match": {"project_id": {"$in": ids}}},
                                     {"$group": {"_id": "$project_id", "c": {"$sum": 1}}}]).to_list(1000)
        return {r["_id"]: r["c"] for r in rows}
    dmap = await _counts(db.drawings)
    tmap = await _counts(db.takeoffs)
    for p in projects:
        p["drawing_count"] = dmap.get(p["id"], 0)
        p["takeoff_count"] = tmap.get(p["id"], 0)
    return projects


@api.post("/projects")
async def create_project(body: ProjectIn, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    plan = await ws_plan(user)
    max_p = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"]).get("max_projects")
    if max_p is not None:
        count = await db.projects.count_documents({"workspace_id": user["workspace_id"], "is_deleted": {"$ne": True}})
        if count >= max_p:
            raise HTTPException(status_code=402, detail=f"The {plan.title()} plan is limited to {max_p} project(s). Upgrade to Pro for unlimited projects.")
    doc = {"id": new_id("proj_"), "workspace_id": user["workspace_id"], "created_by": user["id"],
           "created_at": now_iso(), **body.model_dump()}
    await db.projects.insert_one(doc)
    doc.pop("_id", None)
    await record_audit(user, "created project", "project", doc.get("name", ""))
    return doc


@api.get("/projects/{project_id}")
async def get_project(project_id: str, user: dict = Depends(current_user)):
    p = await db.projects.find_one({"id": project_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    drawings = await db.drawings.find({"project_id": project_id}, {"_id": 0}).to_list(200)
    takeoffs = await db.takeoffs.find({"project_id": project_id}, {"_id": 0}).to_list(200)
    return {"project": p, "drawings": drawings, "takeoffs": takeoffs}


@api.delete("/projects/{project_id}")
async def delete_project(project_id: str, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    await db.projects.delete_one({"id": project_id, "workspace_id": user["workspace_id"]})
    await db.drawings.delete_many({"project_id": project_id})
    await db.takeoffs.delete_many({"project_id": project_id})
    return {"ok": True}


# ---------------- Drawings / files ----------------
@api.post("/projects/{project_id}/drawings")
async def upload_drawing(project_id: str, file: UploadFile = File(...), user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    project = await db.projects.find_one({"id": project_id, "workspace_id": user["workspace_id"]})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    ext = (file.filename.rsplit(".", 1)[-1] if "." in file.filename else "bin").lower()
    content_type = storage.MIME_TYPES.get(ext, file.content_type or "application/octet-stream")
    path = f"{storage.APP_NAME}/{user['workspace_id']}/{project_id}/{new_id()}.{ext}"
    data = await file.read()
    result = await asyncio.to_thread(storage.put_object, path, data, content_type)
    doc = {"id": new_id("draw_"), "project_id": project_id, "workspace_id": user["workspace_id"],
           "name": file.filename, "original_filename": file.filename, "storage_path": result["path"],
           "content_type": content_type, "size": result.get("size", len(data)),
           "calibration": None, "is_deleted": False, "created_at": now_iso()}
    await db.drawings.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.get("/drawings/{drawing_id}/file")
async def get_drawing_file(drawing_id: str, auth: str = Query(None), authorization: str = Header(None)):
    token = auth or (authorization[7:] if authorization and authorization.startswith("Bearer ") else None)
    user = await authenticate_token(token)
    rec = await db.drawings.find_one({"id": drawing_id, "workspace_id": user["workspace_id"], "is_deleted": False}, {"_id": 0})
    if not rec:
        raise HTTPException(status_code=404, detail="Drawing not found")
    data, content_type = await asyncio.to_thread(storage.get_object, rec["storage_path"])
    return Response(content=data, media_type=rec.get("content_type", content_type))


@api.post("/drawings/{drawing_id}/calibrate")
async def calibrate(drawing_id: str, body: CalibrationIn, user: dict = Depends(current_user)):
    scale = body.real_length / body.pixel_length if body.pixel_length else None
    page = max(int(body.page or 1), 1)
    entry = {"scale": scale, "unit": body.unit, "pixel_length": body.pixel_length, "real_length": body.real_length}
    update = {f"calibrations.{page}": entry}
    if page == 1:  # keep top-level calibration for back-compat / default
        update["calibration"] = entry
    await db.drawings.update_one(
        {"id": drawing_id, "workspace_id": user["workspace_id"]}, {"$set": update})
    return {"scale": scale, "unit": body.unit, "page": page}


# ---------------- Tiles catalog ----------------
@api.get("/tiles")
async def list_tiles(user: dict = Depends(current_user)):
    return await db.tiles.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)


@api.post("/tiles")
async def create_tile(body: TileIn, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    doc = {"id": new_id("tile_"), "workspace_id": user["workspace_id"], "created_at": now_iso(),
           **body.model_dump()}
    await db.tiles.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.put("/tiles/{tile_id}")
async def update_tile(tile_id: str, body: TileIn, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    await db.tiles.update_one({"id": tile_id, "workspace_id": user["workspace_id"]},
                              {"$set": body.model_dump()})
    return await db.tiles.find_one({"id": tile_id}, {"_id": 0})


@api.delete("/tiles/{tile_id}")
async def delete_tile(tile_id: str, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    await db.tiles.delete_one({"id": tile_id, "workspace_id": user["workspace_id"]})
    return {"ok": True}


def _f(v, default=0.0):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


@api.post("/tiles/import")
async def import_tiles(file: UploadFile = File(...), user: dict = Depends(current_user)):
    """Bulk-import tiles from a CSV (manufacturer SKU / price list).

    Recognised headers (case-insensitive, flexible): name, collection, width, height, unit,
    finish, color, pattern, grout/grout_spacing, waste/waste_pct/waste_factor,
    price/price_per_sqft, box/box_coverage_sqft.
    """
    require_role(user, "admin", "estimator")
    import csv as _csv
    import io as _io
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    reader = _csv.DictReader(_io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV has no header row")
    norm = {fn: (fn or "").strip().lower() for fn in reader.fieldnames}

    def pick(row, *keys, default=""):
        for fn, low in norm.items():
            if low in keys:
                val = row.get(fn)
                if val not in (None, ""):
                    return val
        return default

    docs, errors = [], []
    for i, row in enumerate(reader, start=2):
        name = str(pick(row, "name", "tile", "tile name")).strip()
        if not name:
            continue
        waste = pick(row, "waste_factor", "waste", "waste_pct", "waste %", default="")
        wf = _f(waste, 10.0)
        if wf > 1:  # treat 10 / 10% as a percentage
            wf = wf / 100.0
        try:
            doc = {
                "id": new_id("tile_"), "workspace_id": user["workspace_id"], "created_at": now_iso(),
                "name": name,
                "sku": str(pick(row, "sku", "item", "item #", "item number", "model", default="")).strip(),
                "manufacturer": str(pick(row, "manufacturer", "mfr", "brand", "maker", default="")).strip(),
                "distributor": str(pick(row, "distributor", "supplier", "vendor", "dealer", default="")).strip(),
                "collection": str(pick(row, "collection", "series", default="")).strip(),
                "width": _f(pick(row, "width", "w", "width (in)"), 12.0),
                "height": _f(pick(row, "height", "h", "height (in)"), 12.0),
                "unit": (str(pick(row, "unit", default="in")).strip() or "in"),
                "finish": str(pick(row, "finish", default="Matte")).strip() or "Matte",
                "color": str(pick(row, "color", "colour", default="#cccccc")).strip() or "#cccccc",
                "image_url": str(pick(row, "image_url", "image", default="")).strip(),
                "grout_spacing": _f(pick(row, "grout_spacing", "grout", "grout (in)"), 0.125),
                "pattern": str(pick(row, "pattern", default="Grid")).strip() or "Grid",
                "waste_factor": wf,
                "price_per_sqft": _f(pick(row, "price_per_sqft", "price", "$/sqft", "price/sqft"), 0.0),
                "box_coverage_sqft": _f(pick(row, "box_coverage_sqft", "box", "box coverage", "box coverage (sf)"), 10.0),
            }
            docs.append(doc)
        except Exception as e:
            errors.append(f"row {i}: {e}")
    if docs:
        await db.tiles.insert_many(docs)
        for d in docs:
            d.pop("_id", None)
    return {"imported": len(docs), "errors": errors, "tiles": docs}


# ---------------- Takeoffs ----------------
@api.post("/projects/{project_id}/takeoffs")
async def create_takeoff(project_id: str, body: TakeoffIn, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    doc = {"id": new_id("tk_"), "project_id": project_id, "workspace_id": user["workspace_id"],
           "name": body.name, "type": body.type, "drawing_id": body.drawing_id,
           "measurements": [], "default_tile_id": None, "ai_suggestions": None,
           "created_at": now_iso(), "updated_at": now_iso()}
    await db.takeoffs.insert_one(doc)
    doc.pop("_id", None)
    await record_audit(user, "created takeoff", "takeoff", body.name)
    return doc


@api.get("/takeoffs/{takeoff_id}")
async def get_takeoff(takeoff_id: str, user: dict = Depends(current_user)):
    tk = await db.takeoffs.find_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not tk:
        raise HTTPException(status_code=404, detail="Takeoff not found")
    drawing = await db.drawings.find_one({"id": tk.get("drawing_id")}, {"_id": 0}) if tk.get("drawing_id") else None
    tiles = await db.tiles.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).to_list(500)
    summary = calc.compute_summary(tk, drawing, tiles)
    return {"takeoff": tk, "drawing": drawing, "summary": summary}


@api.put("/takeoffs/{takeoff_id}")
async def update_takeoff(takeoff_id: str, body: TakeoffUpdate, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    update = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if "measurements" in update:
        update["measurements"] = [m if isinstance(m, dict) else m.model_dump() for m in update["measurements"]]
    update["updated_at"] = now_iso()
    await db.takeoffs.update_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"$set": update})
    tk = await db.takeoffs.find_one({"id": takeoff_id}, {"_id": 0})
    drawing = await db.drawings.find_one({"id": tk.get("drawing_id")}, {"_id": 0}) if tk.get("drawing_id") else None
    tiles = await db.tiles.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).to_list(500)
    return {"takeoff": tk, "summary": calc.compute_summary(tk, drawing, tiles)}


@api.delete("/takeoffs/{takeoff_id}")
async def delete_takeoff(takeoff_id: str, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    await db.takeoffs.delete_one({"id": takeoff_id, "workspace_id": user["workspace_id"]})
    await db.takeoff_revisions.delete_many({"takeoff_id": takeoff_id})
    return {"ok": True}


# ---------------- Revision history ----------------
@api.post("/takeoffs/{takeoff_id}/snapshot")
async def snapshot_takeoff(takeoff_id: str, request: Request, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    tk = await db.takeoffs.find_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not tk:
        raise HTTPException(status_code=404, detail="Takeoff not found")
    body = await request.json() if await request.body() else {}
    drawing = await db.drawings.find_one({"id": tk.get("drawing_id")}, {"_id": 0}) if tk.get("drawing_id") else None
    tiles = await db.tiles.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).to_list(500)
    summary = calc.compute_summary(tk, drawing, tiles)
    rev = {"id": new_id("rev_"), "takeoff_id": takeoff_id, "workspace_id": user["workspace_id"],
           "created_at": now_iso(), "created_by": user.get("name") or user.get("email"),
           "label": (body.get("label") or "").strip() or f"Snapshot {now_iso()[:19].replace('T', ' ')}",
           "measurements": tk.get("measurements", []), "default_tile_id": tk.get("default_tile_id"),
           "totals": summary.get("totals", {})}
    await db.takeoff_revisions.insert_one(dict(rev))
    rev.pop("_id", None)
    await record_audit(user, "saved snapshot", "takeoff", rev["label"])
    return rev


@api.get("/takeoffs/{takeoff_id}/revisions")
async def list_revisions(takeoff_id: str, user: dict = Depends(current_user)):
    revs = await db.takeoff_revisions.find(
        {"takeoff_id": takeoff_id, "workspace_id": user["workspace_id"]},
        {"_id": 0, "measurements": 0}).sort("created_at", -1).to_list(100)
    return {"revisions": revs}


@api.post("/takeoffs/{takeoff_id}/revisions/{rev_id}/restore")
async def restore_revision(takeoff_id: str, rev_id: str, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    rev = await db.takeoff_revisions.find_one({"id": rev_id, "takeoff_id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not rev:
        raise HTTPException(status_code=404, detail="Revision not found")
    await db.takeoffs.update_one({"id": takeoff_id, "workspace_id": user["workspace_id"]},
                                 {"$set": {"measurements": rev.get("measurements", []),
                                           "default_tile_id": rev.get("default_tile_id"), "updated_at": now_iso()}})
    tk = await db.takeoffs.find_one({"id": takeoff_id}, {"_id": 0})
    drawing = await db.drawings.find_one({"id": tk.get("drawing_id")}, {"_id": 0}) if tk.get("drawing_id") else None
    tiles = await db.tiles.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).to_list(500)
    return {"takeoff": tk, "summary": calc.compute_summary(tk, drawing, tiles)}


# ---------------- AI assist ----------------
@api.post("/takeoffs/{takeoff_id}/ai-analyze")
async def ai_analyze(takeoff_id: str, page: int = Query(1), user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    await require_feature(user, "ai")
    tk = await db.takeoffs.find_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not tk:
        raise HTTPException(status_code=404, detail="Takeoff not found")
    if not tk.get("drawing_id"):
        raise HTTPException(status_code=400, detail="Attach a drawing to the takeoff first")
    drawing = await db.drawings.find_one({"id": tk["drawing_id"]}, {"_id": 0})
    data, _ = await asyncio.to_thread(storage.get_object, drawing["storage_path"])
    page_idx = max(int(page), 1) - 1
    if drawing.get("content_type", "").startswith("application/pdf"):
        try:
            import fitz
            doc = fitz.open(stream=data, filetype="pdf")
            idx = min(page_idx, doc.page_count - 1)
            pg = doc.load_page(idx)
            pix = pg.get_pixmap(matrix=fitz.Matrix(2, 2))
            data = pix.tobytes("png")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"PDF rasterization failed: {e}")
    img_b64 = base64.b64encode(data).decode("utf-8")
    try:
        result = await ai_service.analyze_drawing(img_b64, tk.get("type", "floor"))
    except Exception as e:
        logger.error(f"AI error: {e}")
        raise HTTPException(status_code=500, detail=f"AI analysis failed: {e}")
    result["generated_at"] = now_iso()
    result["status"] = "pending"
    result["page"] = page_idx + 1
    await db.takeoffs.update_one({"id": takeoff_id}, {"$set": {"ai_suggestions": result}})
    return result


@api.post("/takeoffs/{takeoff_id}/ai-region-status")
async def ai_region_status(takeoff_id: str, request: Request, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    body = await request.json()
    idx = int(body.get("index", -1))
    status = body.get("status")  # 'accepted' | 'rejected' | 'pending'
    tk = await db.takeoffs.find_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not tk or not tk.get("ai_suggestions"):
        raise HTTPException(status_code=404, detail="No AI suggestions to update")
    regions = tk["ai_suggestions"].get("regions", [])
    if idx < 0 or idx >= len(regions):
        raise HTTPException(status_code=400, detail="Invalid region index")
    regions[idx]["status"] = status
    await db.takeoffs.update_one({"id": takeoff_id}, {"$set": {"ai_suggestions.regions": regions}})
    return {"ok": True, "index": idx, "status": status}


# ---------------- Reports / export ----------------
async def _gather_report(takeoff_id: str, user: dict):
    tk = await db.takeoffs.find_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not tk:
        raise HTTPException(status_code=404, detail="Takeoff not found")
    project = await db.projects.find_one({"id": tk["project_id"]}, {"_id": 0})
    drawing = await db.drawings.find_one({"id": tk.get("drawing_id")}, {"_id": 0}) if tk.get("drawing_id") else None
    tiles = await db.tiles.find({"workspace_id": user["workspace_id"]}, {"_id": 0}).to_list(500)
    summary = calc.compute_summary(tk, drawing, tiles)
    return project, tk, summary


@api.get("/takeoffs/{takeoff_id}/export/{fmt}")
async def export_takeoff(takeoff_id: str, fmt: str, auth: str = Query(None),
                         authorization: str = Header(None)):
    token = auth or (authorization[7:] if authorization and authorization.startswith("Bearer ") else None)
    user = await authenticate_token(token)
    await require_feature(user, "exports")
    project, tk, summary = await _gather_report(takeoff_id, user)
    if fmt == "csv":
        return Response(calc.build_csv(project, tk, summary), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{tk["name"]}.csv"'})
    if fmt == "xlsx":
        return Response(calc.build_xlsx(project, tk, summary), media_type=storage.MIME_TYPES["xlsx"],
                        headers={"Content-Disposition": f'attachment; filename="{tk["name"]}.xlsx"'})
    if fmt == "pdf":
        return Response(calc.build_pdf(project, tk, summary), media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{tk["name"]}.pdf"'})
    raise HTTPException(status_code=400, detail="Unsupported format")


@api.post("/takeoffs/{takeoff_id}/email")
async def email_report(takeoff_id: str, request: Request, user: dict = Depends(current_user)):
    body = await request.json()
    recipient = body.get("recipient_email")
    if not recipient:
        raise HTTPException(status_code=400, detail="recipient_email required")
    await require_feature(user, "email")
    project, tk, summary = await _gather_report(takeoff_id, user)
    html = calc.summary_html(project, tk, summary)
    if not resend.api_key:
        raise HTTPException(status_code=503, detail="Email not configured: set RESEND_API_KEY")
    pdf_bytes = calc.build_pdf(project, tk, summary)
    params = {
        "from": SENDER_EMAIL, "to": [recipient],
        "subject": f"TileTakeoff Estimate — {project['name']}", "html": html,
        "attachments": [{"filename": f"{tk['name']}.pdf", "content": list(pdf_bytes)}],
    }
    if body.get("message"):
        params["html"] = f"<p>{body['message']}</p>" + html
    try:
        result = await asyncio.to_thread(resend.Emails.send, params)
        await record_audit(user, "emailed report", "takeoff", f"{tk['name']} → {recipient}")
        return {"status": "success", "email_id": result.get("id") if isinstance(result, dict) else getattr(result, "id", None)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {e}")


@api.get("/")
async def root():
    return {"service": "TileTakeoff API", "status": "ok"}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    try:
        await db.users.create_index("email", unique=True)
        await db.users.create_index("workspace_id")
        await db.projects.create_index("workspace_id")
        await db.tiles.create_index("workspace_id")
        await db.user_sessions.create_index("session_token")
    except Exception as e:
        logger.warning(f"index creation: {e}")
    try:
        storage.init_storage()
        logger.info("Storage initialized")
    except Exception as e:
        logger.error(f"Storage init failed: {e}")
    await seed_admin()
    logger.info("Startup complete")


@app.on_event("shutdown")
async def shutdown():
    client_close = getattr(__import__("models"), "client", None)
