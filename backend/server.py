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

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="TileTakeoff API")
api = APIRouter(prefix="/api")

resend.api_key = os.environ.get("RESEND_API_KEY", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")


async def current_user(request: Request) -> dict:
    return await get_current_user(request)


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
    doc = {"id": new_id("proj_"), "workspace_id": user["workspace_id"], "created_by": user["id"],
           "created_at": now_iso(), **body.model_dump()}
    await db.projects.insert_one(doc)
    doc.pop("_id", None)
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
    await db.drawings.update_one(
        {"id": drawing_id, "workspace_id": user["workspace_id"]},
        {"$set": {"calibration": {"scale": scale, "unit": body.unit,
                                  "pixel_length": body.pixel_length, "real_length": body.real_length}}})
    return {"scale": scale, "unit": body.unit}


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
    return {"ok": True}


# ---------------- AI assist ----------------
@api.post("/takeoffs/{takeoff_id}/ai-analyze")
async def ai_analyze(takeoff_id: str, user: dict = Depends(current_user)):
    require_role(user, "admin", "estimator")
    tk = await db.takeoffs.find_one({"id": takeoff_id, "workspace_id": user["workspace_id"]}, {"_id": 0})
    if not tk:
        raise HTTPException(status_code=404, detail="Takeoff not found")
    if not tk.get("drawing_id"):
        raise HTTPException(status_code=400, detail="Attach a drawing to the takeoff first")
    drawing = await db.drawings.find_one({"id": tk["drawing_id"]}, {"_id": 0})
    data, _ = await asyncio.to_thread(storage.get_object, drawing["storage_path"])
    if drawing.get("content_type", "").startswith("application/pdf"):
        try:
            import fitz
            doc = fitz.open(stream=data, filetype="pdf")
            page = doc.load_page(0)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
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
    await db.takeoffs.update_one({"id": takeoff_id}, {"$set": {"ai_suggestions": result}})
    return result


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
    project, tk, summary = await _gather_report(takeoff_id, user)
    html = calc.summary_html(project, tk, summary)
    if not resend.api_key:
        raise HTTPException(status_code=503, detail="Email not configured: set RESEND_API_KEY")
    params = {"from": SENDER_EMAIL, "to": [recipient],
              "subject": f"TileTakeoff Estimate — {project['name']}", "html": html}
    try:
        result = await asyncio.to_thread(resend.Emails.send, params)
        return {"status": "success", "email_id": result.get("id")}
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
