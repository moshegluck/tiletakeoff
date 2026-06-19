"""Database, models, and helpers for TileTakeoff."""
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Any, Dict

from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr, ConfigDict

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


# ---------- Auth models ----------
class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    company_name: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class InviteRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    role: str = "estimator"


# ---------- Domain models ----------
class ProjectIn(BaseModel):
    name: str
    client: Optional[str] = ""
    address: Optional[str] = ""
    status: Optional[str] = "active"
    notes: Optional[str] = ""


class TileIn(BaseModel):
    name: str
    collection: Optional[str] = ""
    width: float = 12.0
    height: float = 12.0
    unit: str = "in"
    finish: Optional[str] = "Matte"
    color: Optional[str] = "#cccccc"
    image_url: Optional[str] = ""
    grout_spacing: float = 0.125
    pattern: str = "Grid"
    waste_factor: float = 0.10
    price_per_sqft: float = 0.0
    box_coverage_sqft: float = 10.0


class CalibrationIn(BaseModel):
    pixel_length: float
    real_length: float
    unit: str = "ft"
    page: int = 1


class Measurement(BaseModel):
    model_config = ConfigDict(extra="allow")  # allow rich style/layout fields
    id: str = Field(default_factory=lambda: new_id("m_"))
    type: str  # area | linear | count | perimeter | polygon | wall | opening | text
    label: Optional[str] = ""
    points: List[List[float]] = []
    count: int = 1
    is_deduction: bool = False
    tile_id: Optional[str] = None
    raw_value: float = 0.0   # pixel-based (area in px^2 or length in px)
    color: Optional[str] = "#EA580C"


class TakeoffIn(BaseModel):
    name: str
    type: str = "floor"  # floor | wall
    drawing_id: Optional[str] = None


class TakeoffUpdate(BaseModel):
    name: Optional[str] = None
    measurements: Optional[List[Measurement]] = None
    default_tile_id: Optional[str] = None


class AIRequest(BaseModel):
    drawing_id: str
    takeoff_type: str = "floor"
