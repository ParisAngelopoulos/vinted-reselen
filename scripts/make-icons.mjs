/**
 * Generates the extension icons.
 *
 * Kept as a script rather than committed binaries that nobody can edit: the
 * shapes are signed distance fields, so every size is rendered directly with
 * clean antialiasing. Run `node scripts/make-icons.mjs` after changing them.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

const TEAL = [0x09, 0xb1, 0xba];
const WHITE = [0xff, 0xff, 0xff];

// ------------------------------------------------------------ SDF shapes ---

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const length = (x, y) => Math.hypot(x, y);

/** Rounded box centred on the origin, half-extents (bx, by), corner radius r. */
function sdRoundBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return length(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Annulus of radius r and thickness t, centred on the origin. */
function sdRing(px, py, r, t) {
  return Math.abs(length(px, py) - r) - t / 2;
}

/** Triangle through three points: distance to the nearest edge, negative inside. */
function sdTriangle(px, py, a, b, c) {
  const distanceToSegment = (p0, p1) => {
    const ex = p1[0] - p0[0];
    const ey = p1[1] - p0[1];
    const vx = px - p0[0];
    const vy = py - p0[1];
    const h = clamp((vx * ex + vy * ey) / (ex * ex + ey * ey), 0, 1);
    return length(vx - ex * h, vy - ey * h);
  };

  const distance = Math.min(
    distanceToSegment(a, b),
    distanceToSegment(b, c),
    distanceToSegment(c, a),
  );
  const inside =
    sameSide(px, py, a[0], a[1], b[0], b[1], c[0], c[1]) &&
    sameSide(px, py, b[0], b[1], c[0], c[1], a[0], a[1]) &&
    sameSide(px, py, c[0], c[1], a[0], a[1], b[0], b[1]);
  return inside ? -distance : distance;
}

function sameSide(px, py, ax, ay, bx, by, cx, cy) {
  const cross1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const cross2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return cross1 * cross2 >= 0;
}

/** Coverage from a distance, antialiased over roughly one pixel. */
function coverage(distance, aa) {
  return clamp(0.5 - distance / aa, 0, 1);
}

function over(dst, src, alpha) {
  for (let i = 0; i < 3; i += 1) {
    dst[i] = Math.round(src[i] * alpha + dst[i] * (1 - alpha));
  }
  dst[3] = Math.round(255 * alpha + dst[3] * (1 - alpha));
}

// --------------------------------------------------------------- drawing ---

/**
 * A circular "relist" arrow on a rounded teal tile: a ring with a gap, plus an
 * arrowhead at the open end.
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const aa = 1.6 / size; // work in normalised units, so AA scales with size
  const ringRadius = 0.3;
  const ringThickness = size <= 16 ? 0.13 : 0.11;
  // Leave the top-right open for the arrowhead.
  const gapStart = -0.55; // radians
  const gapEnd = 0.75;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Normalised coordinates in [-0.5, 0.5], y pointing up.
      const px = (x + 0.5) / size - 0.5;
      const py = 0.5 - (y + 0.5) / size;

      const rgba = [0, 0, 0, 0];

      const tile = sdRoundBox(px, py, 0.47, 0.47, 0.12);
      over(rgba, TEAL, coverage(tile, aa));

      let ring = sdRing(px, py, ringRadius, ringThickness);
      const angle = Math.atan2(py, px);
      if (angle > gapStart && angle < gapEnd) ring = 1; // cut the gap out

      const head = arrowHead(px, py, ringRadius, ringThickness, gapEnd);
      const glyph = Math.min(ring, head);
      over(rgba, WHITE, coverage(glyph, aa));

      const offset = (y * size + x) * 4;
      pixels[offset] = rgba[0];
      pixels[offset + 1] = rgba[1];
      pixels[offset + 2] = rgba[2];
      pixels[offset + 3] = rgba[3];
    }
  }
  return pixels;
}

function arrowHead(px, py, radius, thickness, angle) {
  const cx = Math.cos(angle) * radius;
  const cy = Math.sin(angle) * radius;
  // Tangent direction at that point, pointing clockwise round the ring.
  const tx = Math.sin(angle);
  const ty = -Math.cos(angle);
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const half = thickness * 1.35;
  const len = thickness * 2.1;

  const tip = [cx + tx * len, cy + ty * len];
  const left = [cx + nx * half, cy + ny * half];
  const right = [cx - nx * half, cy - ny * half];
  return sdTriangle(px, py, tip, left, right);
}

// ------------------------------------------------------------ PNG output ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (0 = none) per scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, renderIcon(size)));
  console.log(`wrote ${file}`);
}
