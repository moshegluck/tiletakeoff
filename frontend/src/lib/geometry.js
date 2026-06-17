// Geometry + measurement helpers for the takeoff canvas
export const TOOLS = {
  select: { label: "Select", cursor: "default" },
  calibrate: { label: "Calibrate Scale", cursor: "crosshair" },
  area: { label: "Area / Room", cursor: "crosshair", color: "#EA580C", kind: "polygon" },
  wall: { label: "Wall Surface", cursor: "crosshair", color: "#7C3AED", kind: "polygon" },
  perimeter: { label: "Perimeter", cursor: "crosshair", color: "#0EA5E9", kind: "path" },
  linear: { label: "Linear", cursor: "crosshair", color: "#2563EB", kind: "line" },
  opening: { label: "Opening / Deduct", cursor: "crosshair", color: "#DC2626", kind: "polygon" },
  count: { label: "Count", cursor: "crosshair", color: "#16A34A", kind: "count" },
};

export const AREA_TYPES = ["area", "wall", "opening"];
export const LINEAR_TYPES = ["linear", "perimeter"];

export function shoelace(points) {
  if (points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function pathLength(points) {
  let t = 0;
  for (let i = 0; i < points.length - 1; i++) {
    t += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return t;
}

export function centroid(points) {
  const n = points.length || 1;
  const x = points.reduce((a, p) => a + p[0], 0) / n;
  const y = points.reduce((a, p) => a + p[1], 0) / n;
  return [x, y];
}

// real measurement value (sqft or ft) given calibration scale (units/px)
export function realValue(m, scale) {
  if (!scale) return null;
  if (AREA_TYPES.includes(m.type)) return shoelace(m.points) * scale * scale;
  if (LINEAR_TYPES.includes(m.type)) return pathLength(m.points) * scale;
  return null;
}
