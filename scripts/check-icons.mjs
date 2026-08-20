#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_ICONS = Object.freeze({
  "logo-source.png": Object.freeze({
    width: 400,
    height: 400,
    sha256: "f316115b354e523c138110f2d3ebaabe7331c966bd23af0c836ba495b4292ab1",
  }),
  "icon-16.png": Object.freeze({
    width: 16,
    height: 16,
    sha256: "0351cb3d1e9c23aa16ed1984d93151ef095fa7d4aea252733afb020f54d8b7f2",
  }),
  "icon-32.png": Object.freeze({
    width: 32,
    height: 32,
    sha256: "8f8727e583b3de2972290119a0dc34b7b1a0f665615e39a1e9f509d80b76e744",
  }),
  "icon-48.png": Object.freeze({
    width: 48,
    height: 48,
    sha256: "3b000abe939688ce6f9e814d151102fcf052383a0b9789c5600f5b53e7cc9461",
  }),
  "icon-128.png": Object.freeze({
    width: 128,
    height: 128,
    sha256: "ec2aa908467154b34d06cb88976aca40dde76ae003f0e275c800092c4d8817e9",
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
