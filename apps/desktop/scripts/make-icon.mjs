#!/usr/bin/env node
/**
 * Generates the app and tray icons with no image dependencies — a hand-rolled
 * PNG encoder is about forty lines, and it keeps the build free of a native
 * imaging library just to draw a mark.
 *
 *   assets/icon.png          1024px  app icon, charcoal tile + amber helm mark
 *   assets/trayTemplate.png  32px    macOS template image (black + alpha)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(ASSETS, { recursive: true });

/* ---------- minimal PNG writer (RGBA, no interlacing) ---------- */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // rows are prefixed with a filter byte (0 = none)
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the mark: a ship's helm, drawn analytically ---------- */

/** Coverage of the helm shape at a point, 0..1, sampled 3x3 for smooth edges. */
function helmAlpha(px, py, size) {
  const c = size / 2;
  const R = size * 0.36; // outer ring
  const r = size * 0.26; // inner ring
  const hub = size * 0.075;
  const spokeW = size * 0.035;
  const handleOut = size * 0.46;

  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3 - c;
      const y = py + (sy + 0.5) / 3 - c;
      const d = Math.hypot(x, y);

      let on = (d <= R && d >= r) || d <= hub;

      if (!on && d < handleOut) {
        // eight spokes and their handles, every 45 degrees
        for (let k = 0; k < 8 && !on; k++) {
          const a = (k * Math.PI) / 4;
          const along = x * Math.cos(a) + y * Math.sin(a);
          const across = -x * Math.sin(a) + y * Math.cos(a);
          if (along > 0 && along <= handleOut && Math.abs(across) <= spokeW) on = true;
        }
      }
      if (on) hits++;
    }
  }
  return hits / 9;
}

function draw({ size, fg, bg, radius }) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let bgA = 0;
      if (bg) {
        // rounded tile
        const rx = Math.max(radius - x, x - (size - 1 - radius), 0);
        const ry = Math.max(radius - y, y - (size - 1 - radius), 0);
        bgA = Math.hypot(rx, ry) <= radius ? 1 : 0;
      }
      const a = helmAlpha(x, y, size);
      const r = bg ? bg[0] : 0;
      const g = bg ? bg[1] : 0;
      const b = bg ? bg[2] : 0;
      buf[i] = Math.round(r * (1 - a) + fg[0] * a);
      buf[i + 1] = Math.round(g * (1 - a) + fg[1] * a);
      buf[i + 2] = Math.round(b * (1 - a) + fg[2] * a);
      buf[i + 3] = Math.round(255 * Math.max(bgA, a));
    }
  }
  return png(size, size, buf);
}

writeFileSync(
  join(ASSETS, 'icon.png'),
  draw({ size: 1024, fg: [232, 163, 61], bg: [11, 13, 18], radius: 190 }),
);

// macOS template images are pure black plus alpha; the system recolours them
// for light and dark menu bars.
writeFileSync(join(ASSETS, 'trayTemplate.png'), draw({ size: 22, fg: [0, 0, 0], bg: null }));
writeFileSync(join(ASSETS, 'trayTemplate@2x.png'), draw({ size: 44, fg: [0, 0, 0], bg: null }));

process.stdout.write(`▲ icons written to ${ASSETS}\n`);
