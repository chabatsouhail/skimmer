"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const BLUE = [11, 98, 230];
const WHITE = [255, 255, 255];
const PALE_BLUE = [216, 232, 255];
const SUPERSAMPLE = 6;

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    let value = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const flag = (crc ^ value) & 1;
      crc = (crc >>> 1) ^ (flag ? 0xedb88320 : 0);
      value >>>= 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const closestX = Math.max(left + radius, Math.min(right - radius, x));
  const closestY = Math.max(top + radius, Math.min(bottom - radius, y));
  if (
    (x >= left + radius && x <= right - radius) ||
    (y >= top + radius && y <= bottom - radius)
  ) {
    return true;
  }
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegmentSquared(x, y, startX, endX, lineY) {
  const closestX = Math.max(startX, Math.min(endX, x));
  const dx = x - closestX;
  const dy = y - lineY;
  return dx * dx + dy * dy;
}

function sampleMark(x, y) {
  if (!insideRoundedRect(x, y, 2, 2, 22, 22, 5)) return null;
  if (
    distanceToSegmentSquared(x, y, 6.5, 17.5, 8) <= 1 ||
    distanceToSegmentSquared(x, y, 6.5, 15, 12) <= 1 ||
    distanceToSegmentSquared(x, y, 6.5, 12.5, 16) <= 1
  ) {
    return WHITE;
  }
  const dotX = x - 17.5;
  const dotY = y - 16;
  if (dotX * dotX + dotY * dotY <= 1.5 * 1.5) return PALE_BLUE;
  return BLUE;
}

function createPng(size) {
  const rowSize = 1 + size * 4;
  const raw = Buffer.alloc(size * rowSize);
  const scale = size / 24;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * rowSize;
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      let filled = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sampleY = 0; sampleY < SUPERSAMPLE; sampleY += 1) {
        for (let sampleX = 0; sampleX < SUPERSAMPLE; sampleX += 1) {
          const iconX = (x + (sampleX + 0.5) / SUPERSAMPLE) / scale;
          const iconY = (y + (sampleY + 0.5) / SUPERSAMPLE) / scale;
          const color = sampleMark(iconX, iconY);
          if (!color) continue;
          filled += 1;
          red += color[0];
          green += color[1];
          blue += color[2];
        }
      }
      if (filled === 0) continue;
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = Math.round(red / filled);
      raw[offset + 1] = Math.round(green / filled);
      raw[offset + 2] = Math.round(blue / filled);
      raw[offset + 3] = Math.round(255 * filled / samples);
    }
  }

  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    signature,
    makeChunk("IHDR", header),
    makeChunk("IDAT", zlib.deflateSync(raw)),
    makeChunk("IEND", Buffer.alloc(0))
  ]);
}

const iconsDirectory = path.resolve(__dirname, "..", "icons");
fs.mkdirSync(iconsDirectory, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const target = path.join(iconsDirectory, `icon${size}.png`);
  fs.writeFileSync(target, createPng(size));
  console.log(`Generated ${target}`);
}
