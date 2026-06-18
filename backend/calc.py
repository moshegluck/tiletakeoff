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


def _fmt_dim(v):
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


def _eff_dims(m):
    """Custom tile width/height (inches) entered per room, if any."""
    cw, ch = m.get("custom_w"), m.get("custom_h")
    try:
        cw, ch = float(cw), float(ch)
    except (TypeError, ValueError):
        return None, None
    return (cw, ch) if cw > 0 and ch > 0 else (None, None)


# Recommended total waste allowance per layout (single allowance, not additive).
# These are the industry rules of thumb a contractor orders (~10% straight, ~15% diagonal,
# ~18-20% herringbone). The manufacturer waste_factor acts as a floor.
PATTERN_WASTE = {"grid": 0.10, "brick": 0.12, "offset": 0.12, "diagonal": 0.15,
                 "herringbone": 0.18, "basketweave": 0.15, "chevron": 0.18,
                 "checkerboard": 0.12, "mosaic": 0.10}

_ZERO_Q = {"tile_area": 0, "full_tiles": 0, "cut_tiles": 0, "reused_cuts": 0,
           "tiles_needed": 0, "true_waste_pct": 0, "boxes": 0, "cost": 0}


def _mosaic_quantities(net_area, tile, reuse, waste_override=None):
    """Mosaic is sold by the sheet (default 12x12 = 1 sqft per sheet)."""
    sheet_area = tile.get("sheet_area_sqft", 1.0) or 1.0
    if waste_override is not None and waste_override >= 0:
        waste_pct = waste_override
    else:
        waste_pct = max(0.10, tile.get("waste_factor", 0.10) or 0.0)
        if reuse:
            waste_pct = max(waste_pct - 0.03, 0.05)
    sheets = math.ceil(net_area / sheet_area * (1 + waste_pct))
    box_cov = tile.get("box_coverage_sqft", 10.0) or 10.0
    boxes = math.ceil((sheets * sheet_area) / box_cov)
    cost = sheets * sheet_area * tile.get("price_per_sqft", 0.0)
    true_waste = (sheets * sheet_area - net_area) / net_area * 100.0 if net_area else 0
    return {"tile_area": round(sheet_area, 3), "full_tiles": sheets, "cut_tiles": 0,
            "reused_cuts": 0, "tiles_needed": sheets, "true_waste_pct": round(true_waste, 1),
            "boxes": boxes, "cost": round(cost, 2)}


def tile_quantities(net_area, perimeter_ft, tile, pattern, reuse=True, waste_override=None):
    """Area-based estimate (MeasureSquare-style).

    Tiles are ordered to cover the net area plus a single layout-appropriate waste
    allowance. The full/cut split is an informational cut sheet that sums to the number
    of tiles actually installed; the order quantity adds the waste allowance on top.
    A per-room waste_override (fraction, e.g. 0.15) replaces the automatic allowance.
    """
    w, h = tile["width"], tile["height"]
    tile_area = (w * h) / 144.0 if tile.get("unit", "in") == "in" else w * h
    if tile_area <= 0 or net_area <= 0:
        return dict(_ZERO_Q, tile_area=round(tile_area, 3))

    pat = (pattern or "grid").lower()
    if pat == "mosaic":
        return _mosaic_quantities(net_area, tile, reuse, waste_override)

    # tiles physically required to cover the area (rounding up captures partial-tile rows)
    installed = math.ceil(net_area / tile_area)

    if waste_override is not None and waste_override >= 0:
        waste_pct = waste_override
    else:
        # single waste allowance: the larger of the pattern rule and the manufacturer floor
        waste_pct = max(PATTERN_WASTE.get(pat, 0.10), tile.get("waste_factor", 0.10) or 0.0)
        if reuse:  # offcuts reused on opposing edges recover a few %, floor at 5%
            waste_pct = max(waste_pct - 0.03, 0.05)
    tiles_needed = math.ceil(installed * (1 + waste_pct))

    # cut sheet: interior full tiles vs perimeter cut tiles (sums to installed)
    side = math.sqrt(installed)
    full_tiles = min(max(math.floor(side) - 2, 0) ** 2, installed)
    cut_tiles = max(installed - full_tiles, 0)
    reused = math.floor(cut_tiles * 0.35) if reuse else 0

    box_cov = tile.get("box_coverage_sqft", 10.0) or 10.0
    boxes = math.ceil((tiles_needed * tile_area) / box_cov)
    cost = tiles_needed * tile_area * tile.get("price_per_sqft", 0.0)
    true_waste = (tiles_needed * tile_area - net_area) / net_area * 100.0 if net_area else 0
    return {"tile_area": round(tile_area, 3), "full_tiles": full_tiles, "cut_tiles": cut_tiles,
            "reused_cuts": reused, "tiles_needed": tiles_needed, "true_waste_pct": round(true_waste, 1),
            "boxes": boxes, "cost": round(cost, 2)}


def compute_summary(takeoff: dict, drawing: dict, tiles: list) -> dict:
    """Returns a dict with per-tile quantities and totals."""
    calib = (drawing or {}).get("calibration") or {}
    scale = calib.get("scale")  # real units per pixel
    unit = calib.get("unit", "ft")
    tiles_map = {t["id"]: t for t in tiles}
    default_tile_id = takeoff.get("default_tile_id")
    reuse = takeoff.get("cut_reuse", True)

    # Area groups keyed by tile + effective size + pattern so rooms with custom
    # dimensions (or a mosaic layout) form their own line. Deductions / linear / count
    # accumulate per tile id and attach to that tile's largest area group.
    groups = {}
    deduct_by_tid = defaultdict(float)
    linear_by_tid = defaultdict(float)
    count_by_tid = defaultdict(int)
    rooms = []
    total_gross = 0.0
    total_deduct = 0.0
    total_linear = 0.0
    total_count = 0
    calibrated = scale is not None

    for m in takeoff.get("measurements", []):
        tid = m.get("tile_id") or default_tile_id or "__unassigned__"
        mtype = m.get("type")
        pts = m.get("points", [])
        base_tile = tiles_map.get(tid)
        cw, ch = _eff_dims(m)
        if cw and ch:
            ew, eh, custom = cw, ch, True
        elif base_tile:
            ew, eh, custom = base_tile["width"], base_tile["height"], False
        else:
            ew, eh, custom = None, None, False
        pat = (m.get("pattern") or "").lower() or None
        try:
            wo = float(m.get("waste_override"))
            wo = wo / 100.0 if wo > 1 else wo  # accept 15 or 0.15
        except (TypeError, ValueError):
            wo = None

        if mtype in AREA_TYPES or mtype == "opening":
            real_area = _shoelace(pts) * (scale ** 2) if calibrated else 0.0
            if m.get("is_deduction") or mtype == "opening":
                deduct_by_tid[tid] += real_area
                total_deduct += real_area
            else:
                total_gross += real_area
                eff_pat = pat or (base_tile.get("pattern") if base_tile else "grid")
                sig = f"{tid}|{ew}|{eh}|{(eff_pat or 'grid').lower()}"
                g = groups.get(sig)
                if not g:
                    g = {"tid": tid, "gross": 0.0, "ew": ew, "eh": eh, "custom": custom,
                         "pattern": (eff_pat or "grid").lower(), "base": base_tile, "waste_override": None}
                    groups[sig] = g
                g["gross"] += real_area
                if wo is not None:
                    g["waste_override"] = wo
                rooms.append({"label": m.get("label", "Area"), "net_area": round(real_area, 2),
                              "tile_name": base_tile["name"] if base_tile else (f"Custom {ew}×{eh}" if ew else "Unassigned"),
                              "pattern": g["pattern"]})
        elif mtype in LINEAR_TYPES:
            real_len = _path_length(pts) * scale if calibrated else 0.0
            linear_by_tid[tid] += real_len
            total_linear += real_len
            # wall-elevation: a wall line with a height becomes an area (length x height)
            try:
                wh = float(m.get("wall_height_ft") or m.get("wall_height") or 0)
            except (TypeError, ValueError):
                wh = 0.0
            if wh > 0 and real_len > 0:
                wall_area = real_len * wh
                total_gross += wall_area
                eff_pat = pat or (base_tile.get("pattern") if base_tile else "grid")
                sig = f"{tid}|{ew}|{eh}|{(eff_pat or 'grid').lower()}"
                g = groups.get(sig)
                if not g:
                    g = {"tid": tid, "gross": 0.0, "ew": ew, "eh": eh, "custom": custom,
                         "pattern": (eff_pat or "grid").lower(), "base": base_tile, "waste_override": None}
                    groups[sig] = g
                g["gross"] += wall_area
                if wo is not None:
                    g["waste_override"] = wo
                rooms.append({"label": m.get("label", "Wall") + f" ({real_len:.1f}×{wh:g} ft)",
                              "net_area": round(wall_area, 2),
                              "tile_name": base_tile["name"] if base_tile else (f"Custom {ew}×{eh}" if ew else "Unassigned"),
                              "pattern": g["pattern"]})
        elif mtype == "count":
            count_by_tid[tid] += int(m.get("count", 1))
            total_count += int(m.get("count", 1))

    # distribute per-tid deductions across that tile's area groups (largest first)
    by_tid = defaultdict(list)
    for sig, g in groups.items():
        by_tid[g["tid"]].append(g)
    for tid, glist in by_tid.items():
        glist.sort(key=lambda x: x["gross"], reverse=True)
        ded = deduct_by_tid.get(tid, 0.0)
        for g in glist:
            take = min(ded, g["gross"])
            g["net"] = max(g["gross"] - take, 0.0)
            g["deduct"] = take
            ded -= take
        # leftover linear/count attach to the primary (largest) group
        if glist:
            glist[0]["linear"] = linear_by_tid.get(tid, 0.0)
            glist[0]["count"] = count_by_tid.get(tid, 0)

    lines = []
    grand_cost = grand_tiles = grand_boxes = grand_full = grand_cuts = grand_reused = 0
    handled_tids = set()
    for sig, g in groups.items():
        handled_tids.add(g["tid"])
        net_area = g.get("net", g["gross"])
        base = g["base"]
        linear = g.get("linear", 0.0)
        count = g.get("count", 0)
        if (base or g["ew"]) and net_area > 0:
            eff_tile = dict(base) if base else {"name": f"Custom {g['ew']}×{g['eh']}", "unit": "in",
                                                "waste_factor": 0.10, "box_coverage_sqft": 10.0, "price_per_sqft": 0.0}
            eff_tile["width"] = g["ew"]; eff_tile["height"] = g["eh"]
            q = tile_quantities(net_area, linear, eff_tile, g["pattern"], reuse, g.get("waste_override"))
            grand_cost += q["cost"]; grand_tiles += q["tiles_needed"]; grand_boxes += q["boxes"]
            grand_full += q["full_tiles"]; grand_cuts += q["cut_tiles"]; grand_reused += q["reused_cuts"]
            unit_lbl = eff_tile.get("unit", "in")
            size_lbl = f'{_fmt_dim(g["ew"])}x{_fmt_dim(g["eh"])} {unit_lbl}' + (" · mosaic sheet" if g["pattern"] == "mosaic" else (" · custom" if g["custom"] else ""))
            lines.append({
                "tile_id": g["tid"], "tile_name": eff_tile["name"], "tile_size": size_lbl,
                "pattern": g["pattern"], "gross_area": round(g["gross"], 2),
                "deduct_area": round(g.get("deduct", 0.0), 2), "net_area": round(net_area, 2),
                "full_tiles": q["full_tiles"], "cut_tiles": q["cut_tiles"], "reused_cuts": q["reused_cuts"],
                "waste_pct": q["true_waste_pct"], "true_waste_pct": q["true_waste_pct"],
                "area_with_waste": round(q["tiles_needed"] * q["tile_area"], 2),
                "tiles_needed": q["tiles_needed"], "boxes": q["boxes"],
                "price_per_sqft": eff_tile.get("price_per_sqft", 0.0), "cost": q["cost"],
                "linear": round(linear, 2), "count": count,
            })
        elif net_area > 0 or linear > 0 or count > 0:
            lines.append({
                "tile_id": g["tid"], "tile_name": "Unassigned", "tile_size": "-", "pattern": "-",
                "gross_area": round(g["gross"], 2), "deduct_area": round(g.get("deduct", 0.0), 2),
                "net_area": round(net_area, 2), "full_tiles": 0, "cut_tiles": 0, "reused_cuts": 0,
                "waste_pct": 0, "true_waste_pct": 0, "area_with_waste": round(net_area, 2),
                "tiles_needed": 0, "boxes": 0, "price_per_sqft": 0, "cost": 0,
                "linear": round(linear, 2), "count": count,
            })

    # tile ids that only had linear / count (no area) get a standalone line
    for tid in set(list(linear_by_tid) + list(count_by_tid)):
        if tid in handled_tids:
            continue
        linear = linear_by_tid.get(tid, 0.0)
        count = count_by_tid.get(tid, 0)
        if linear <= 0 and count <= 0:
            continue
        base = tiles_map.get(tid)
        lines.append({
            "tile_id": tid, "tile_name": base["name"] if base else "Unassigned",
            "tile_size": "-", "pattern": "-", "gross_area": 0, "deduct_area": 0, "net_area": 0,
            "full_tiles": 0, "cut_tiles": 0, "reused_cuts": 0, "waste_pct": 0, "true_waste_pct": 0,
            "area_with_waste": 0, "tiles_needed": 0, "boxes": 0, "price_per_sqft": 0, "cost": 0,
            "linear": round(linear, 2), "count": count,
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
