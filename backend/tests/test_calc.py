"""Regression tests for the tile quantity / waste engine."""
import math
import calc


def _tile(w, h, **kw):
    base = {"name": "T", "width": w, "height": h, "unit": "in", "waste_factor": 0.10,
            "box_coverage_sqft": 10.0, "price_per_sqft": 5.0, "pattern": "grid"}
    base.update(kw)
    return base


def test_large_format_waste_is_realistic():
    # 24x48 (8 sqft) large-format on ~200sf room must NOT explode to 80%+ waste
    q = calc.tile_quantities(201.5, 0, _tile(24, 48, price_per_sqft=8.5), "grid", True)
    assert q["true_waste_pct"] < 20, q
    assert q["tiles_needed"] >= math.ceil(201.5 / 8)
    assert q["full_tiles"] + q["cut_tiles"] == math.ceil(201.5 / 8)  # installed tiles


def test_small_tile_waste_reasonable():
    q = calc.tile_quantities(201.5, 0, _tile(12, 12), "grid", True)
    assert 5 <= q["true_waste_pct"] <= 15, q
    assert q["tiles_needed"] >= math.ceil(201.5)


def test_pattern_increases_waste():
    grid = calc.tile_quantities(150, 0, _tile(12, 24), "grid", True)
    herr = calc.tile_quantities(150, 0, _tile(12, 24), "herringbone", True)
    assert herr["tiles_needed"] >= grid["tiles_needed"]


def test_reuse_reduces_order():
    on = calc.tile_quantities(150, 0, _tile(12, 24), "grid", True)
    off = calc.tile_quantities(150, 0, _tile(12, 24), "grid", False)
    assert on["tiles_needed"] <= off["tiles_needed"]


def test_mosaic_sold_by_sheet():
    q = calc.tile_quantities(100, 0, _tile(2, 2, price_per_sqft=12.0), "mosaic", True)
    assert q["cut_tiles"] == 0  # mosaic has no whole-tile cuts
    assert q["tiles_needed"] >= 100  # ~1 sqft sheets
    assert q["true_waste_pct"] < 15


def test_zero_area():
    q = calc.tile_quantities(0, 0, _tile(12, 12), "grid", True)
    assert q["tiles_needed"] == 0


def test_compute_summary_custom_dims_separate_lines():
    scale = 0.05
    # two rooms, same default tile, different custom sizes -> two lines
    takeoff = {
        "default_tile_id": "t1", "cut_reuse": True,
        "measurements": [
            {"id": "a", "type": "area", "label": "R1", "points": [[0, 0], [200, 0], [200, 200], [0, 200]], "custom_w": 12, "custom_h": 24},
            {"id": "b", "type": "area", "label": "R2", "points": [[0, 0], [200, 0], [200, 200], [0, 200]], "custom_w": 24, "custom_h": 48},
        ],
    }
    tiles = [{"id": "t1", "name": "Base", "width": 12, "height": 12, "unit": "in",
              "waste_factor": 0.1, "box_coverage_sqft": 10.0, "price_per_sqft": 4.0, "pattern": "grid"}]
    drawing = {"calibration": {"scale": scale, "unit": "ft"}}
    s = calc.compute_summary(takeoff, drawing, tiles)
    sizes = sorted(l["tile_size"] for l in s["lines"])
    assert len(s["lines"]) == 2, s["lines"]
    assert any("12x24" in x for x in sizes) and any("24x48" in x for x in sizes)


def test_wall_elevation_length_times_height():
    scale = 0.05
    # a 10ft wall line (200px * 0.05 = 10ft) with 8ft height => 80 sqft of wall
    takeoff = {
        "default_tile_id": "t1", "cut_reuse": True,
        "measurements": [
            {"id": "w", "type": "linear", "label": "Wall A", "points": [[0, 0], [200, 0]], "wall_height_ft": 8},
        ],
    }
    tiles = [{"id": "t1", "name": "Sub", "width": 3, "height": 6, "unit": "in",
              "waste_factor": 0.1, "box_coverage_sqft": 10.0, "price_per_sqft": 2.1, "pattern": "brick"}]
    drawing = {"calibration": {"scale": scale, "unit": "ft"}}
    s = calc.compute_summary(takeoff, drawing, tiles)
    assert s["totals"]["net_area"] == 80.0, s["totals"]
    assert s["lines"][0]["tiles_needed"] > 0
    assert s["lines"][0]["linear"] == 10.0


def test_per_page_calibration():
    # page 1 uses scale 0.05, page 2 uses scale 0.10; same pixel polygon => different areas
    takeoff = {
        "default_tile_id": "t1", "cut_reuse": True,
        "measurements": [
            {"id": "a", "type": "area", "label": "P1", "points": [[0, 0], [200, 0], [200, 200], [0, 200]], "page": 1},
            {"id": "b", "type": "area", "label": "P2", "points": [[0, 0], [200, 0], [200, 200], [0, 200]], "page": 2},
        ],
    }
    tiles = [{"id": "t1", "name": "Base", "width": 12, "height": 12, "unit": "in",
              "waste_factor": 0.1, "box_coverage_sqft": 10.0, "price_per_sqft": 4.0, "pattern": "grid"}]
    drawing = {"calibration": {"scale": 0.05, "unit": "ft"},
               "calibrations": {"1": {"scale": 0.05, "unit": "ft"}, "2": {"scale": 0.10, "unit": "ft"}}}
    s = calc.compute_summary(takeoff, drawing, tiles)
    # page1: (200*0.05)^2 = 100 sf ; page2: (200*0.10)^2 = 400 sf ; total 500
    assert round(s["totals"]["net_area"]) == 500, s["totals"]


def test_waste_override_applies():
    base = _tile(12, 12)
    auto = calc.tile_quantities(200, 0, base, "grid", True)
    over = calc.tile_quantities(200, 0, base, "grid", True, 0.25)
    assert over["tiles_needed"] == math.ceil(math.ceil(200) * 1.25)
    assert over["tiles_needed"] > auto["tiles_needed"]


def test_compute_summary_deduction_nets():
    scale = 0.05
    takeoff = {
        "default_tile_id": "t1", "cut_reuse": True,
        "measurements": [
            {"id": "a", "type": "area", "label": "R1", "points": [[0, 0], [400, 0], [400, 400], [0, 400]]},
            {"id": "d", "type": "area", "label": "Cut", "points": [[0, 0], [100, 0], [100, 100], [0, 100]], "is_deduction": True},
        ],
    }
    tiles = [{"id": "t1", "name": "Base", "width": 12, "height": 12, "unit": "in",
              "waste_factor": 0.1, "box_coverage_sqft": 10.0, "price_per_sqft": 4.0, "pattern": "grid"}]
    drawing = {"calibration": {"scale": scale, "unit": "ft"}}
    s = calc.compute_summary(takeoff, drawing, tiles)
    line = s["lines"][0]
    assert line["deduct_area"] > 0
    assert line["net_area"] < line["gross_area"]
