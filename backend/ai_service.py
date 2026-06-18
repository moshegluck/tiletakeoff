"""AI-assisted takeoff using Gemini 3.1 Pro vision via Emergent LLM key."""
import os
import json
import base64

from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY")

SYSTEM_PROMPT = (
    "You are a tile takeoff estimation assistant for professional flooring/wall contractors. "
    "You analyze architectural floor plans and wall elevation drawings. "
    "Identify tileable regions (rooms for floor takeoffs, wall faces for wall takeoffs), "
    "estimate their approximate dimensions and areas, detect openings (doors, windows) that "
    "should be deducted, and recommend a waste allowance percentage based on layout complexity. "
    "Always respond with STRICT, valid JSON only — no markdown, no prose."
)


async def analyze_drawing(image_b64: str, takeoff_type: str) -> dict:
    instruction = (
        f"This is a {takeoff_type} plan. Return JSON with this exact shape:\n"
        "{\n"
        '  "regions": [ {"label": "Kitchen", "type": "room|wall", "est_area_sqft": 120.5, '
        '"confidence": 0.0-1.0, "polygon": [[x,y],[x,y],...], "notes": "short"} ],\n'
        '  "openings": [ {"label": "Door", "est_area_sqft": 21.0, "confidence": 0.0-1.0} ],\n'
        '  "recommended_waste_pct": 10,\n'
        '  "summary": "1-2 sentence overview"\n'
        "}\n"
        "For every region, ALWAYS include a 'polygon' tracing the room outline as 4-8 [x,y] points "
        "in NORMALIZED image coordinates where x and y are each between 0.0 (left/top) and 1.0 "
        "(right/bottom). Provide 2-6 regions. Be realistic with scale. JSON only, no markdown."
    )
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"takeoff-{takeoff_type}",
        system_message=SYSTEM_PROMPT,
    ).with_model("gemini", "gemini-3.1-pro-preview")

    img = ImageContent(image_base64=image_b64)
    msg = UserMessage(text=instruction, file_contents=[img])
    text = await chat.send_message(msg)
    return _parse_json(text)


def _parse_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
    text = text.strip().strip("`").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]
    try:
        return json.loads(text)
    except Exception:
        return {"regions": [], "openings": [], "recommended_waste_pct": 10,
                "summary": "AI response could not be parsed.", "raw": text[:500]}
