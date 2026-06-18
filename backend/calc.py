"""Quantity calculation engine + report generation (Excel/PDF/CSV)."""
import io
import math
import csv as csvlib
from collections import defaultdict

from openpyxl import Workbook
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

AREA_TYPES = {"area", "polygon", "wall"}
LINEAR_TYPES = {"linear", "perimeter"}


def _shoelace(points):
    n = len(points)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def _path_length(points):
    total = 0.0
    for i in range(len(points) - 1):
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        total += math.hypot(x2 - x1, y2 - y1)
    return total


PATTERN_WASTE = {"grid": 0.0, "brick": 0.05, "offset": 0.05, "diagonal": 0.15,
                 "herringbone": 0.15, "basketweave": 0.10, "chevron": 0.15, "checkerboard": 0.05}


def tile_quantities(net_area, perimeter_ft, tile, pattern, reuse=True):
    """MeasureSquare-style estimate: full tiles + edge cuts with leftover reuse."""
    w, h = tile["width"], tile["height"]
    tile_area = (w * h) / 144.0 if tile.get("unit", "in") == "in" else w * h
    if tile_area <= 0 or net_area <= 0:
        return {"tile_area": round(tile_area, 3), "full_tiles": 0, "cut_tiles": 0,
                "reused_cuts": 0, "tiles_needed": 0, "true_waste_pct": 0, "boxes": 0, "cost": 0}
    tile_w_ft = min(w, h) / 12.0
    full_tiles = math.floor(net_area / tile_area)
    if not perimeter_ft or perimeter_ft <= 0:
        perimeter_ft = 4.0 * math.sqrt(net_area)
    cuts = math.ceil(perimeter_ft / tile_w_ft) if tile_w_ft > 0 else 0
    reused = math.floor(cuts * 0.45) if reuse else 0
    net_cut_tiles = max(cuts - reused, 0)
    subtotal = full_tiles + net_cut_tiles
    pat_waste = PATTERN_WASTE.get((pattern or "grid").lower(), 0.05)
    manuf_waste = tile.get("waste_factor", 0.10)
    ordered = math.ceil(subtotal * (1 + pat_waste))
    ordered = math.ceil(ordered * (1 + manuf_waste))
    box_cov = tile.get("box_coverage_sqft", 10.0) or 10.0
    boxes = math.ceil((ordered * tile_area) / box_cov)
    cost = ordered * tile_area * tile.get("price_per_sqft", 0.0)
    true_waste = (ordered * tile_area - net_area) / net_area * 100.0 if net_area else 0
    return {"tile_area": round(tile_area, 3), "full_tiles": full_tiles, "cut_tiles": cuts,
            "reused_cuts": reused, "tiles_needed": ordered, "true_waste_pct": round(true_waste, 1),
            "boxes": boxes, "cost": round(cost, 2)}


def compute_summary(takeoff: dict, drawing: dict, tiles: list) -> dict:
    """Returns a dict with per-tile quantities and totals."""
    calib = (drawing or {}).get("calibration") or {}
    scale = calib.get("scale")  # real units per pixel
    unit = calib.get("unit", "ft")
    tiles_map = {t["id"]: t for t in tiles}
    default_tile_id = takeoff.get("default_tile_id")
    reuse = takeoff.get("cut_reuse", True)

    groups = defaultdict(lambda: {"gross_area": 0.0, "deduct_area": 0.0,
                                  "linear": 0.0, "count": 0, "pattern": None})
    rooms = []
    total_gross = 0.0
    total_deduct = 0.0
    total_linear = 0.0
    total_count = 0
    calibrated = scale is not None

    for m in takeoff.get("measurements", []):
        tid = m.get("tile_id") or default_tile_id or "__unassigned__"
        g = groups[tid]
        mtype = m.get("type")
        pts = m.get("points", [])
        if mtype in AREA_TYPES or mtype == "opening":
            px_area = _shoelace(pts)
            real_area = px_area * (scale ** 2) if calibrated else 0.0
            if m.get("is_deduction") or mtype == "opening":
                g["deduct_area"] += real_area
                total_deduct += real_area
            else:
                g["gross_area"] += real_area
                total_gross += real_area
                if m.get("pattern"):
                    g["pattern"] = m.get("pattern")
                t = tiles_map.get(tid)
                rooms.append({"label": m.get("label", "Area"), "net_area": round(real_area, 2),
                              "tile_name": t["name"] if t else "Unassigned",
                              "pattern": m.get("pattern") or (t.get("pattern") if t else "-")})
        elif mtype in LINEAR_TYPES:
            px_len = _path_length(pts)
            real_len = px_len * scale if calibrated else 0.0
            g["linear"] += real_len
            total_linear += real_len
        elif mtype == "count":
            g["count"] += int(m.get("count", 1))
            total_count += int(m.get("count", 1))

    lines = []
    grand_cost = 0.0
    grand_tiles = 0
    grand_boxes = 0
    grand_full = 0
    grand_cuts = 0
    grand_reused = 0
    for tid, g in groups.items():
        net_area = max(g["gross_area"] - g["deduct_area"], 0.0)
        tile = tiles_map.get(tid)
        if tile and net_area > 0:
            pattern = g["pattern"] or tile.get("pattern", "grid")
            q = tile_quantities(net_area, g["linear"], tile, pattern, reuse)
            grand_cost += q["cost"]; grand_tiles += q["tiles_needed"]; grand_boxes += q["boxes"]
            grand_full += q["full_tiles"]; grand_cuts += q["cut_tiles"]; grand_reused += q["reused_cuts"]
            lines.append({
                "tile_id": tid, "tile_name": tile["name"],
                "tile_size": f'{tile["width"]}x{tile["height"]} {tile.get("unit","in")}',
                "pattern": pattern, "gross_area": round(g["gross_area"], 2),
                "deduct_area": round(g["deduct_area"], 2), "net_area": round(net_area, 2),
                "full_tiles": q["full_tiles"], "cut_tiles": q["cut_tiles"], "reused_cuts": q["reused_cuts"],
                "waste_pct": q["true_waste_pct"], "true_waste_pct": q["true_waste_pct"],
                "area_with_waste": round(q["tiles_needed"] * q["tile_area"], 2),
                "tiles_needed": q["tiles_needed"], "boxes": q["boxes"],
                "price_per_sqft": tile.get("price_per_sqft", 0.0), "cost": q["cost"],
                "linear": round(g["linear"], 2), "count": g["count"],
            })
        elif tile is None and (net_area > 0 or g["linear"] > 0 or g["count"] > 0):
            lines.append({
                "tile_id": tid, "tile_name": "Unassigned", "tile_size": "-", "pattern": "-",
                "gross_area": round(g["gross_area"], 2), "deduct_area": round(g["deduct_area"], 2),
                "net_area": round(net_area, 2), "full_tiles": 0, "cut_tiles": 0, "reused_cuts": 0,
                "waste_pct": 0, "true_waste_pct": 0, "area_with_waste": round(net_area, 2),
                "tiles_needed": 0, "boxes": 0, "price_per_sqft": 0, "cost": 0,
                "linear": round(g["linear"], 2), "count": g["count"],
            })

    return {
        "calibrated": calibrated, "unit": unit, "rooms": rooms,
        "totals": {
            "gross_area": round(total_gross, 2), "deduct_area": round(total_deduct, 2),
            "net_area": round(max(total_gross - total_deduct, 0.0), 2),
            "linear": round(total_linear, 2), "count": total_count,
            "full_tiles": grand_full, "cut_tiles": grand_cuts, "reused_cuts": grand_reused,
            "tiles_needed": grand_tiles, "boxes": grand_boxes, "cost": round(grand_cost, 2),
        },
        "lines": lines,
    }


def build_csv(project, takeoff, summary) -> bytes:
    buf = io.StringIO()
    w = csvlib.writer(buf)
    w.writerow(["TileTakeoff Report"])
    w.writerow(["Project", project["name"], "Takeoff", takeoff["name"], "Type", takeoff["type"]])
    w.writerow([])
    w.writerow(["Tile", "Size", "Pattern", "Net Area (sqft)", "Waste %", "With Waste", "Tiles", "Boxes", "$/sqft", "Cost"])
    for l in summary["lines"]:
        w.writerow([l["tile_name"], l["tile_size"], l["pattern"], l["net_area"], l["waste_pct"],
                    l["area_with_waste"], l["tiles_needed"], l["boxes"], l["price_per_sqft"], l["cost"]])
    t = summary["totals"]
    w.writerow([])
    w.writerow(["TOTAL", "", "", t["net_area"], "", "", t["tiles_needed"], t["boxes"], "", t["cost"]])
    return buf.getvalue().encode("utf-8")


def build_xlsx(project, takeoff, summary) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Takeoff"
    ws.append(["TileTakeoff Report"])
    ws.append(["Project", project["name"]])
    ws.append(["Takeoff", takeoff["name"], "Type", takeoff["type"]])
    ws.append([])
    ws.append(["Tile", "Size", "Pattern", "Net Area (sqft)", "Waste %", "With Waste", "Tiles", "Boxes", "$/sqft", "Cost"])
    for l in summary["lines"]:
        ws.append([l["tile_name"], l["tile_size"], l["pattern"], l["net_area"], l["waste_pct"],
                   l["area_with_waste"], l["tiles_needed"], l["boxes"], l["price_per_sqft"], l["cost"]])
    t = summary["totals"]
    ws.append([])
    ws.append(["TOTAL", "", "", t["net_area"], "", "", t["tiles_needed"], t["boxes"], "", t["cost"]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_pdf(project, takeoff, summary) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, topMargin=0.6 * inch)
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], textColor=colors.HexColor("#0F172A"))
    accent = ParagraphStyle("a", parent=styles["Normal"], textColor=colors.HexColor("#EA580C"), fontSize=10)
    elems = [Paragraph("TileTakeoff — Estimate Report", title),
             Paragraph(f'Project: {project["name"]}  |  {project.get("client","")}', accent),
             Paragraph(f'Takeoff: {takeoff["name"]} ({takeoff["type"]})', styles["Normal"]),
             Spacer(1, 14)]
    data = [["Tile", "Size", "Net Area", "Waste%", "Tiles", "Boxes", "Cost ($)"]]
    for l in summary["lines"]:
        data.append([l["tile_name"], l["tile_size"], f'{l["net_area"]}', f'{l["waste_pct"]}',
                     l["tiles_needed"], l["boxes"], f'{l["cost"]:,.2f}'])
    t = summary["totals"]
    data.append(["TOTAL", "", f'{t["net_area"]}', "", t["tiles_needed"], t["boxes"], f'{t["cost"]:,.2f}'])
    table = Table(data, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0F172A")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#FFF7ED")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#F8FAFC")]),
    ]))
    elems.append(table)

    # Cut sheet (full vs cut vs reused per tile)
    elems.append(Spacer(1, 18))
    elems.append(Paragraph("Cut Sheet — installed pieces & waste optimization", accent))
    elems.append(Spacer(1, 6))
    cut = [["Tile", "Full Tiles", "Cut Tiles", "Reused Cuts", "Boxes", "True Waste %"]]
    for l in summary["lines"]:
        cut.append([l["tile_name"], l.get("full_tiles", 0), l.get("cut_tiles", 0),
                    l.get("reused_cuts", 0), l.get("boxes", 0), f'{l.get("true_waste_pct", 0)}%'])
    ct = summary["totals"]
    cut.append(["TOTAL", ct.get("full_tiles", 0), ct.get("cut_tiles", 0), ct.get("reused_cuts", 0), ct.get("boxes", 0), ""])
    ctable = Table(cut, repeatRows=1)
    ctable.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EA580C")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#FFF7ED")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#F8FAFC")]),
    ]))
    elems.append(ctable)

    if summary.get("rooms"):
        elems.append(Spacer(1, 18))
        elems.append(Paragraph("Per-Room Breakdown", accent))
        elems.append(Spacer(1, 6))
        rdata = [["Room", "Area (sf)", "Tile", "Pattern"]]
        for r in summary["rooms"]:
            rdata.append([r["label"], r["net_area"], r["tile_name"], r["pattern"]])
        rtable = Table(rdata, repeatRows=1)
        rtable.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#334155")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
        ]))
        elems.append(rtable)

    doc.build(elems)
    return buf.getvalue()


def summary_html(project, takeoff, summary) -> str:
    rows = ""
    for l in summary["lines"]:
        rows += f"<tr><td>{l['tile_name']}</td><td>{l['tile_size']}</td><td>{l['net_area']}</td><td>{l['tiles_needed']}</td><td>{l['boxes']}</td><td>${l['cost']:,.2f}</td></tr>"
    t = summary["totals"]
    return f"""
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;border:1px solid #E2E8F0">
      <div style="background:#0F172A;color:#fff;padding:20px"><h2 style="margin:0">TileTakeoff Estimate</h2>
      <p style="margin:4px 0 0;color:#EA580C">{project['name']} — {takeoff['name']}</p></div>
      <div style="padding:20px">
      <table style="width:100%;border-collapse:collapse" cellpadding="8">
      <tr style="background:#F1F5F9;text-align:left"><th>Tile</th><th>Size</th><th>Net Area</th><th>Tiles</th><th>Boxes</th><th>Cost</th></tr>
      {rows}
      <tr style="background:#FFF7ED;font-weight:bold"><td>TOTAL</td><td></td><td>{t['net_area']}</td><td>{t['tiles_needed']}</td><td>{t['boxes']}</td><td>${t['cost']:,.2f}</td></tr>
      </table></div></div>"""
