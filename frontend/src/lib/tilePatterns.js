import React from "react";

export const PATTERNS = ["grid", "brick", "diagonal", "herringbone", "basketweave", "chevron", "checkerboard"];

function shade(hex, amt) {
  try {
    const n = parseInt(hex.replace("#", ""), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  } catch { return hex; }
}

// Returns a <pattern> element visualizing a tile layout in world (px) units.
export function TilePattern({ id, tile, pattern, scale, opacity = 0.85 }) {
  const pxPerFt = scale ? 1 / scale : 22; // fallback so tiles are visible uncalibrated
  const wIn = tile?.width || 12, hIn = tile?.height || 12;
  const groutIn = tile?.grout_spacing || 0.125;
  let tw = Math.max((wIn / 12) * pxPerFt, 4);
  let th = Math.max((hIn / 12) * pxPerFt, 4);
  const g = Math.max((groutIn / 12) * pxPerFt, 0.6);
  const color = tile?.color || "#cbd5e1";
  const grout = "#e5e7eb";
  const dark = shade(color, -28);
  const pat = (pattern || tile?.pattern || "grid").toLowerCase();

  const tileRect = (x, y, w, h, c = color, key) => (
    <rect key={key} x={x} y={y} width={w} height={h} fill={c} stroke={shade(c, -40)} strokeWidth={Math.min(g, 1.2)} />
  );

  let cw, ch, content, transform;

  if (pat === "checkerboard") {
    cw = 2 * (tw + g); ch = 2 * (th + g);
    content = [
      tileRect(g / 2, g / 2, tw, th, color, "a"),
      tileRect(tw + 1.5 * g, g / 2, tw, th, dark, "b"),
      tileRect(g / 2, th + 1.5 * g, tw, th, dark, "c"),
      tileRect(tw + 1.5 * g, th + 1.5 * g, tw, th, color, "d"),
    ];
  } else if (pat === "brick" || pat === "offset") {
    cw = tw + g; ch = 2 * (th + g);
    content = [
      tileRect(g / 2, g / 2, tw, th, color, "r0"),
      tileRect(g / 2 - cw / 2, th + 1.5 * g, tw, th, color, "r1a"),
      tileRect(g / 2 + cw / 2, th + 1.5 * g, tw, th, color, "r1b"),
    ];
  } else if (pat === "basketweave") {
    const u = tw; cw = 2 * (u + g); ch = 2 * (u + g);
    const lines = (x, y, horiz, key) =>
      [0, 1].map((i) => horiz
        ? <rect key={`${key}-${i}`} x={x} y={y + i * (u / 2)} width={u} height={u / 2 - g / 2} fill={color} stroke={shade(color, -40)} strokeWidth={0.7} />
        : <rect key={`${key}-${i}`} x={x + i * (u / 2)} y={y} width={u / 2 - g / 2} height={u} fill={dark} stroke={shade(dark, -30)} strokeWidth={0.7} />);
    content = [...lines(g / 2, g / 2, true, "tl"), ...lines(u + 1.5 * g, g / 2, false, "tr"),
              ...lines(g / 2, u + 1.5 * g, false, "bl"), ...lines(u + 1.5 * g, u + 1.5 * g, true, "br")];
  } else if (pat === "herringbone" || pat === "chevron") {
    // elongated planks laid at 45°
    tw = Math.max(tw, 10); th = Math.max(th * 0.5, 5);
    cw = tw + g; ch = 2 * (th + g); transform = "rotate(45)";
    content = [
      tileRect(g / 2, g / 2, tw, th, color, "h0"),
      tileRect(g / 2 - cw / 2, th + 1.5 * g, tw, th, pat === "chevron" ? color : dark, "h1a"),
      tileRect(g / 2 + cw / 2, th + 1.5 * g, tw, th, pat === "chevron" ? color : dark, "h1b"),
    ];
  } else if (pat === "diagonal") {
    cw = tw + g; ch = th + g; transform = "rotate(45)";
    content = [tileRect(g / 2, g / 2, tw, th, color, "d0")];
  } else {
    // grid
    cw = tw + g; ch = th + g;
    content = [tileRect(g / 2, g / 2, tw, th, color, "g0")];
  }

  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={cw} height={ch} patternTransform={transform} opacity={opacity}>
      <rect x={0} y={0} width={cw} height={ch} fill={grout} />
      {content}
    </pattern>
  );
}
