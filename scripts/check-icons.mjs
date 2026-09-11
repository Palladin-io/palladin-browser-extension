#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_ICONS = Object.freeze({
  "logo-source.png": Object.freeze({
    width: 400,
    height: 400,
    sha256: "21bccbb1e1a170559b99b64ac001ae5333a5b9e35ef8adc8f501de9c8f5c250b",
  }),
  "icon-16.png": Object.freeze({
    width: 16,
    height: 16,
    sha256: "80bbb8ba8d475c6032cc1cf44d948047bcc502f9d27169b43d7e88a68c33dbd8",
  }),
  "icon-32.png": Object.freeze({
    width: 32,
    height: 32,
    sha256: "f6a14eff56abff71f96d310f50222e2761d0130a6ce5dc0721626b483ffdfadf",
  }),
  "icon-48.png": Object.freeze({
    width: 48,
    height: 48,
    sha256: "fd9cc4ea75b76fc7c80b161b87b70186d869da52888a1f139ade144bf1ae0144",
  }),
  "icon-128.png": Object.freeze({
    width: 128,
    height: 128,
    sha256: "0171096badc5a43aec72eaabc12c5c5990dc34890b9b476107624df21e595863",
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
