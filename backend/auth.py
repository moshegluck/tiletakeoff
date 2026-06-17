"""Authentication: unified JWT (email/password) + Emergent Google session auth."""
import os
from datetime import datetime, timezone, timedelta

import bcrypt
import jwt
import httpx
from fastapi import HTTPException, Request

from models import db, now_iso, new_id

JWT_ALGORITHM = "HS256"
EMERGENT_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"


def get_jwt_secret() -> str:
    return os.environ["JWT_SECRET"]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=7),
        "type": "access",
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)


def set_auth_cookie(response, token: str):
    response.set_cookie(
        key="access_token", value=token, httponly=True, secure=True,
        samesite="none", max_age=604800, path="/",
    )


def clear_auth_cookie(response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("session_token", path="/")


def _extract_token(request: Request) -> str | None:
    token = request.cookies.get("access_token") or request.cookies.get("session_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    return token


async def _resolve_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
        user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
        if user:
            return user
    except jwt.InvalidTokenError:
        pass
    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if session:
        expires_at = session["expires_at"]
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at >= datetime.now(timezone.utc):
            return await db.users.find_one({"id": session["user_id"]}, {"_id": 0, "password_hash": 0})
    return None


async def authenticate_token(token: str | None) -> dict:
    user = await _resolve_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


async def get_current_user(request: Request) -> dict:
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await authenticate_token(token)


def require_role(user: dict, *roles: str):
    if user.get("role") not in roles:
        raise HTTPException(status_code=403, detail="Insufficient permissions")


async def create_user_with_workspace(name: str, email: str, password_hash: str | None,
                                     company_name: str | None, picture: str = "") -> dict:
    email = email.lower()
    workspace_id = new_id("ws_")
    user_id = new_id("user_")
    ws_name = company_name or f"{name}'s Workspace"
    await db.workspaces.insert_one({
        "id": workspace_id, "name": ws_name, "owner_id": user_id, "created_at": now_iso(),
    })
    user_doc = {
        "id": user_id, "name": name, "email": email, "password_hash": password_hash,
        "role": "admin", "workspace_id": workspace_id, "picture": picture,
        "auth_provider": "jwt" if password_hash else "google", "created_at": now_iso(),
    }
    await db.users.insert_one(user_doc)
    await seed_starter_tiles(workspace_id)
    user_doc.pop("password_hash", None)
    user_doc.pop("_id", None)
    return user_doc


async def exchange_emergent_session(session_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as ac:
        resp = await ac.get(EMERGENT_SESSION_URL, headers={"X-Session-ID": session_id})
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Failed to validate Google session")
    data = resp.json()
    email = data["email"].lower()
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        user = existing
    else:
        user = await create_user_with_workspace(
            data.get("name", email), email, None, None, data.get("picture", ""))
    session_token = data["session_token"]
    await db.user_sessions.insert_one({
        "user_id": user["id"], "session_token": session_token,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        "created_at": now_iso(),
    })
    user.pop("password_hash", None)
    return {"user": user, "session_token": session_token}


STARTER_TILES = [
    {"name": "Calacatta Gold", "collection": "Marble Look", "width": 24, "height": 48,
     "finish": "Polished", "color": "#EDEAE0", "pattern": "Grid", "price_per_sqft": 8.5,
     "image_url": "https://images.unsplash.com/photo-1523350165414-082d792c4bcc?w=400&q=80"},
    {"name": "Urban Concrete", "collection": "Concrete Look", "width": 12, "height": 24,
     "finish": "Matte", "color": "#B8B5AE", "pattern": "Brick", "price_per_sqft": 4.25,
     "image_url": "https://images.unsplash.com/photo-1678742755904-6c3fc8ba6602?w=400&q=80"},
    {"name": "Nordic Oak", "collection": "Wood Look", "width": 8, "height": 48,
     "finish": "Textured", "color": "#C9A77C", "pattern": "Herringbone", "price_per_sqft": 5.75,
     "image_url": "https://images.unsplash.com/photo-1523350165414-082d792c4bcc?w=400&q=80"},
    {"name": "Classic White Subway", "collection": "Ceramic", "width": 3, "height": 6,
     "finish": "Gloss", "color": "#F8F8F6", "pattern": "Brick", "price_per_sqft": 2.10,
     "image_url": "https://images.unsplash.com/photo-1678742755904-6c3fc8ba6602?w=400&q=80"},
]


async def seed_starter_tiles(workspace_id: str):
    docs = []
    for t in STARTER_TILES:
        docs.append({
            "id": new_id("tile_"), "workspace_id": workspace_id, "unit": "in",
            "grout_spacing": 0.125, "waste_factor": 0.10, "box_coverage_sqft": 10.0,
            "created_at": now_iso(), **t,
        })
    if docs:
        await db.tiles.insert_many(docs)


async def seed_admin():
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@tiletakeoff.com").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin123!")
    existing = await db.users.find_one({"email": admin_email})
    if existing is None:
        await create_user_with_workspace("Admin", admin_email, hash_password(admin_password),
                                         "TileTakeoff HQ")
    elif not verify_password(admin_password, existing.get("password_hash") or ""):
        await db.users.update_one({"email": admin_email},
                                  {"$set": {"password_hash": hash_password(admin_password)}})
