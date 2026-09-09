#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_ICONS = Object.freeze({
  "logo-source.png": Object.freeze({
    width: 400,
    height: 400,
    sha256: "cde8920946dd325c126a53b29a6a66a793a34cb1004576d3663cc0d0d0681648",
  }),
  "icon-16.png": Object.freeze({
    width: 16,
    height: 16,
    sha256: "d1d4d6fb4f51d44d63a2a35246827bc1b4595860fa56ad4b799f19afdf3f81ef",
  }),
  "icon-32.png": Object.freeze({
    width: 32,
    height: 32,
    sha256: "5f8e321032f7a352e3d94187bcaf4b4e86cd3feac3653205f3fd697bd524fdf4",
  }),
  "icon-48.png": Object.freeze({
    width: 48,
    height: 48,
    sha256: "601df691c2b81d0479e92b8e8c1dd207617922ff157fd45ee3a611adabaa6797",
  }),
  "icon-128.png": Object.freeze({
    width: 128,
    height: 128,
    sha256: "be34b9bfb7062635abfec793875984fe3a796ecccfd4baccd8cb592ade61f1e3",
  }),
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const [name, expected] of Object.entries(EXPECTED_ICONS)) {
  const path = fileURLToPath(new URL(`../icons/${name}`, import.meta.url));
  const bytes = readFileSync(path);

  if (bytes.length < 29 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${name} is not a valid PNG`);
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (
    width !== expected.width ||
    height !== expected.height ||
    bitDepth !== 8 ||
    colorType !== 6
  ) {
    throw new Error(
      `${name} must be ${expected.width}x${expected.height}, 8-bit RGBA PNG; got ${width}x${height}, bitDepth=${bitDepth}, colorType=${colorType}`,
    );
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) {
    throw new Error(
      `${name} does not match the reviewed Palladin brand asset; update the icon set and checksum together in one reviewed change`,
    );
  }
}

console.log("Validated Palladin brand icon source and 16/32/48/128 derivatives.");
