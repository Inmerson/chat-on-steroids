/**
 * Generates every icon the project ships, with no image dependencies.
 *
 *   build/icon.ico            the Windows app icon (6 sizes in one file)
 *   build/icon-preview.png    256px preview, for looking at what changed
 *   extension/icons/*.png     16/32/48/128 for the Chrome extension
 *
 * Kept as a script rather than committed binaries so the icon is reviewable and
 * reproducible: run `node scripts/make-icon.mjs` (or `npm run icon`) to regenerate.
 *
 * The mark is a folder drawn as a conversation — a two-plane folder with a message
 * tail — because that is exactly what the app is: local files on one side, a chat on
 * the other. Below 48px the tail and the plane split stop resolving, so those sizes
 * drop them and keep the silhouette instead of turning to mush.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const EXTENSION_SIZES = [128, 48, 32, 16];

// A deeper, warmer range than the flat UI accent: #10a37f sits between these two, so
// the tile reads as the same brand at a glance but has somewhere to go across 256px.
const TOP_LEFT = [22, 190, 150];
const BOTTOM_RIGHT = [7, 106, 87];
const WHITE = [255, 255, 255];

// ------------------------------------------------------------------ geometry

/** Coverage test for a rounded rectangle, in unit coordinates. */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Half-plane sign, for the triangle test. */
function side(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = side(x, y, ax, ay, bx, by);
  const d2 = side(x, y, bx, by, cx, cy);
  const d3 = side(x, y, cx, cy, ax, ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** The back plate: the tab and the part of the body that shows above the front. */
function inFolderBack(x, y) {
  return (
    inRoundedRect(x, y, 0.205, 0.275, 0.505, 0.40, 0.035) ||
    inRoundedRect(x, y, 0.205, 0.335, 0.795, 0.70, 0.055)
  );
}

/** The front flap, inset so the back plate reads as a separate plane behind it. */
function inFolderFront(x, y, detailed) {
  const body = inRoundedRect(x, y, 0.225, detailed ? 0.445 : 0.335, 0.775, 0.705, 0.05);
  // The message tail. Merged into the flap so the whole glyph is one silhouette.
  const tail = inTriangle(x, y, [0.285, 0.66], [0.44, 0.66], [0.265, 0.83]);
  return body || tail;
}

/**
 * Renders one square RGBA bitmap.
 *
 * Supersampled rather than analytically antialiased: at these sizes the cost is
 * milliseconds, and it keeps every shape above a plain boolean test.
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const detailed = size >= 48;
  // Small icons need more samples, not fewer: one pixel covers far more of the shape.
  const samples = size >= 128 ? 4 : size >= 32 ? 6 : 8;
  const total = samples * samples;
  const shadowDrop = 0.018;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let back = 0;
      let front = 0;
      let shadow = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.235)) tile++;
          if (inFolderBack(x, y)) back++;
          if (inFolderFront(x, y, detailed)) front++;
          if (detailed && (inFolderBack(x, y - shadowDrop) || inFolderFront(x, y - shadowDrop, detailed))) {
            shadow++;
          }
        }
      }

      const tileA = tile / total;
      const backA = back / total;
      const frontA = front / total;
      const shadowA = Math.max(0, shadow / total - Math.max(backA, frontA));

      // Diagonal gradient, so the light has a direction instead of just a top and a
      // bottom. t runs corner to corner.
      const t = (px / Math.max(1, size - 1) + py / Math.max(1, size - 1)) / 2;
      let rgb = TOP_LEFT.map((c, i) => c + (BOTTOM_RIGHT[i] - c) * t);

      // A specular band across the top third keeps the tile from looking like paper.
      const gloss = Math.max(0, 1 - py / (size * 0.55)) ** 2 * 0.16;
      rgb = rgb.map((c) => c + (255 - c) * gloss);

      // Shadow first, then the two glyph planes over it, back to front.
      rgb = rgb.map((c) => c * (1 - shadowA * 0.28));
      rgb = rgb.map((c, i) => c * (1 - backA * 0.82) + WHITE[i] * backA * 0.82);
      rgb = rgb.map((c, i) => c * (1 - frontA) + WHITE[i] * frontA);

      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(Math.min(255, Math.max(0, rgb[0])));
      pixels[offset + 1] = Math.round(Math.min(255, Math.max(0, rgb[1])));
      pixels[offset + 2] = Math.round(Math.min(255, Math.max(0, rgb[2])));
      pixels[offset + 3] = Math.round(tileA * 255);
    }
  }
  return pixels;
}

// -------------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// -------------------------------------------------------------------- ico

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// ------------------------------------------------------------------- main

const cache = new Map();
const pngFor = (size) => {
  if (!cache.has(size)) cache.set(size, encodePng(size, render(size)));
  return cache.get(size);
};

mkdirSync(path.join(root, 'build'), { recursive: true });
const icoImages = ICO_SIZES.map((size) => ({ size, png: pngFor(size) }));
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(icoImages));
writeFileSync(path.join(root, 'build', 'icon-preview.png'), pngFor(256));
console.log(`Wrote build/icon.ico (${ICO_SIZES.join(', ')}) and build/icon-preview.png`);

const iconsDir = path.join(root, 'extension', 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const size of EXTENSION_SIZES) {
  writeFileSync(path.join(iconsDir, `icon${size}.png`), pngFor(size));
}
console.log(`Wrote extension/icons/icon{${EXTENSION_SIZES.join(',')}}.png`);
