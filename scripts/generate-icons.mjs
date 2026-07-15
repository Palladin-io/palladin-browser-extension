#!/usr/bin/env node
/**
 * Generate placeholder extension icons (16/32/48/128) with no runtime deps.
 * Draws the brand-red tile with a white centered block as a stand-in mark.
 * These are PLACEHOLDERS — replace with the real Palladin icon before store
 * submission (E3). Re-run with: `node scripts/generate-icons.mjs`.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = [0xeb, 0x47, 0x47, 0xff]; // #EB4747
const MARK = [0xff, 0xff, 0xff, 0xff]; // white
const SIZES = [16, 32, 48, 128];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const inset = Math.round(size * 0.3);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const mark =
        x >= inset && x < size - inset && y >= inset && y < size - inset;
      const [r, g, b, a] = mark ? MARK : BRAND;
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
