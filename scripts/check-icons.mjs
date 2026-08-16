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
    sha256: "b3c98598bbd34f683dedf70e2239d805d3b2f275e41f80c8161001ca5ba8d8c2",
  }),
  "icon-32.png": Object.freeze({
    width: 32,
    height: 32,
    sha256: "56b101e8c609ed82a8bb54a95d7fbed93c22b2bd45a29275b07533cd81deb909",
  }),
  "icon-48.png": Object.freeze({
    width: 48,
    height: 48,
    sha256: "b252be399b9be04782157e96a97734f17d924a8ff6ba7f93e2a9720f7f91e72e",
  }),
  "icon-128.png": Object.freeze({
    width: 128,
    height: 128,
    sha256: "ab3e5b43b77a2963423ca1420b212a83f42f17ec1842c32a7442bfef18c52ada",
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
