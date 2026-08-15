/**
 * Generates build/icon.ico (and a preview PNG) with no image dependencies.
 *
 * Kept as a script rather than a committed binary so the icon is reviewable and
 * reproducible: run `node scripts/make-icon.mjs` to regenerate it.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [256, 128, 64, 48, 32, 16];

const ACCENT = [16, 163, 127]; // #10a37f, the same accent the UI uses
const ACCENT_DARK = [13, 138, 107];
const GLYPH = [255, 255, 255];

// ------------------------------------------------------------------ shapes

/** Signed coverage test for a rounded rectangle, in unit coordinates. */
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** A folder silhouette: a tab merged into a body. */
function insideFolder(x, y) {
  const tab = insideRoundedRect(x, y, 0.2, 0.3, 0.48, 0.44, 0.035);
  const body = insideRoundedRect(x, y, 0.2, 0.37, 0.8, 0.72, 0.055);
  return tab || body;
}

/** Renders one square RGBA bitmap with 4x4 supersampling. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let glyphHits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (insideRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) bgHits++;
          if (insideFolder(x, y)) glyphHits++;
        }
      }
      const total = samples * samples;
      const bgA = bgHits / total;
      const glyphA = glyphHits / total;
      // Vertical gradient keeps the tile from looking flat at large sizes.
      const t = py / Math.max(1, size - 1);
      const base = ACCENT.map((c, i) => c + (ACCENT_DARK[i] - c) * t);
      const rgb = base.map((c, i) => c * (1 - glyphA) + GLYPH[i] * glyphA);
      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(rgb[0]);
      pixels[offset + 1] = Math.round(rgb[1]);
      pixels[offset + 2] = Math.round(rgb[2]);
      pixels[offset + 3] = Math.round(bgA * 255);
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

const images = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
mkdirSync(path.join(root, 'build'), { recursive: true });
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(images));
writeFileSync(path.join(root, 'build', 'icon-preview.png'), images[0].png);
console.log(`Wrote build/icon.ico (${SIZES.join(', ')})`);
