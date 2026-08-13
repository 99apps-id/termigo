// Generate the Termigo "T" logo as PNG/ICO/ICNS with zero dependencies.
//
// The design: a rounded-square dark tile, a bold geometric "T" filled with a
// blue->violet gradient, and a cyan terminal cursor block at the lower right —
// the terminal-first feel of Termigo.
//
// Rendering uses signed distance fields with 2x supersampling, so every size
// stays crisp. PNG encoding uses Node's built-in zlib + a hand-rolled CRC32.
import { deflateSync } from "node:zlib";
import { mkdirSync, statSync, writeFileSync } from "node:fs";

// ---- PNG encoder ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- SDF primitives -------------------------------------------------------

function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// union: min of two SDFs, with a smooth blend controlled by k
function smoothUnion(d1, d2, k) {
  const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
  return Math.min(d1, d2) - h * h * k * 0.25;
}

// ---- Logo renderer --------------------------------------------------------

// All coordinates in a 0..1 design space; SDF evaluated per pixel at 2x
// supersampling, then box-downsampled for anti-aliasing.

function shade(x, y) {
  // Background rounded square.
  const bg = sdRoundBox(x, y, 0.5, 0.5, 0.5, 0.5, 0.2);

  // Bold geometric T: horizontal bar + vertical stem.
  const bar = sdRoundBox(x, y, 0.5, 0.285, 0.34, 0.105, 0.045);
  const stem = sdRoundBox(x, y, 0.5, 0.59, 0.06, 0.21, 0.035);
  const letter = smoothUnion(bar, stem, 0.02);

  // Terminal cursor block at the lower right.
  const cursor = sdRoundBox(x, y, 0.74, 0.68, 0.1, 0.1, 0.045);
  const glyph = smoothUnion(letter, cursor, 0.01);

  // Distance to the tile edge (inside = positive).
  const tile = -bg;

  const alphaTile = clamp01(0.5 + tile * 320);
  if (alphaTile <= 0) return [0, 0, 0, 0];

  // Colors.
  const baseR = 0x0f, baseG = 0x14, baseB = 0x22; // dark tile
  const grad = (x + y) / 2; // 0..1 diagonal
  const r1 = 0x74, g1 = 0x9b, b1 = 0xff; // blue #749bff
  const r2 = 0xa7, g2 = 0x6b, b2 = 0xff; // violet #a76bff
  const cR = r1 + (r2 - r1) * grad;
  const cG = g1 + (g2 - g1) * grad;
  const cB = b1 + (b2 - b1) * grad;

  const glyphA = clamp01(0.5 - glyph * 320);

  let r = baseR, g = baseG, b = baseB, a = alphaTile;
  if (glyphA > 0) {
    r = baseR + (cR - baseR) * glyphA;
    g = baseG + (cG - baseG) * glyphA;
    b = baseB + (cB - baseB) * glyphA;
    a = alphaTile;
  }
  return [r, g, b, a];
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function render(size) {
  const ss = 2;
  const S = size * ss;
  const out = Buffer.alloc(size * size * 4);
  const tmp = new Float64Array(size * size * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = (x + 0.5) / S;
      const py = (y + 0.5) / S;
      const [r, g, b, a] = shade(px, py);
      const ox = Math.floor(x / ss);
      const oy = Math.floor(y / ss);
      const i = (oy * size + ox) * 4;
      tmp[i] += r * a;
      tmp[i + 1] += g * a;
      tmp[i + 2] += b * a;
      tmp[i + 3] += a;
    }
  }
  for (let i = 0; i < size * size; i++) {
    const a = tmp[i * 4 + 3] / (ss * ss);
    if (a <= 0) {
      out[i * 4 + 3] = 0;
      continue;
    }
    out[i * 4] = Math.round(tmp[i * 4] / a);
    out[i * 4 + 1] = Math.round(tmp[i * 4 + 1] / a);
    out[i * 4 + 2] = Math.round(tmp[i * 4 + 2] / a);
    out[i * 4 + 3] = Math.round(a);
  }
  return out;
}

// ---- ICO / ICNS -----------------------------------------------------------

// PNG-compressed ICO (supported since Windows Vista).
function encodeIco(sizes) {
  const images = sizes.map((s) => {
    const png = encodePng(s, s, render(s));
    return { s, png };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.s >= 256 ? 0 : img.s;
    e[1] = img.s >= 256 ? 0 : img.s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.png.length;
    entries.push(Buffer.concat([e, img.png]));
  }
  return Buffer.concat([header, ...entries]);
}

// ICNS with PNG-encoded types (ic04..ic10).
function encodeIcns(sizes) {
  const map = {
    16: "ic04",
    32: "ic05",
    128: "ic07",
    256: "ic08",
    512: "ic09",
  };
  const chunks = [];
  for (const s of sizes) {
    const type = map[s];
    if (!type) continue;
    const png = encodePng(s, s, render(s));
    const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.alloc(4), png]);
    body.writeUInt32BE(body.length, 4);
    chunks.push(body);
  }
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

// ---- Main -----------------------------------------------------------------

const iconsDir = "src-tauri/icons";
mkdirSync(iconsDir, { recursive: true });

// App/README logos.
writeFileSync("termigo.png", encodePng(512, 512, render(512)));
writeFileSync("public/logo.png", encodePng(256, 256, render(256)));

// Tauri icons.
writeFileSync(`${iconsDir}/32x32.png`, encodePng(32, 32, render(32)));
writeFileSync(`${iconsDir}/64x64.png`, encodePng(64, 64, render(64)));
writeFileSync(`${iconsDir}/128x128.png`, encodePng(128, 128, render(128)));
writeFileSync(`${iconsDir}/128x128@2x.png`, encodePng(256, 256, render(256)));
writeFileSync(`${iconsDir}/icon.png`, encodePng(512, 512, render(512)));
writeFileSync(`${iconsDir}/icon.ico`, encodeIco([16, 32, 48, 64, 128, 256]));
writeFileSync(`${iconsDir}/icon.icns`, encodeIcns([16, 32, 128, 256, 512]));

// Windows Store / UWP packaging icons.
const storeSizes = [
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
];
for (const [name, size] of storeSizes) {
  writeFileSync(`${iconsDir}/${name}`, encodePng(size, size, render(size)));
}

console.log("Generated Termigo T logo:");
for (const f of [
  "termigo.png",
  "public/logo.png",
  `${iconsDir}/32x32.png`,
  `${iconsDir}/64x64.png`,
  `${iconsDir}/128x128.png`,
  `${iconsDir}/128x128@2x.png`,
  `${iconsDir}/icon.png`,
  `${iconsDir}/icon.ico`,
  `${iconsDir}/icon.icns`,
]) {
  const { size } = statSync(f);
  console.log(`  ${f} (${size} bytes)`);
}
console.log(`  + ${storeSizes.length} Windows Store icons`);
