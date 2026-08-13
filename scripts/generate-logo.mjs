// Derive every Termigo brand asset (PNG/ICO/ICNS) from the master artwork,
// with zero dependencies.
//
// `termigo.png` at the repository root is the master, and this script never
// writes it: it is the input. Everything else (public/logo.png and the whole
// src-tauri/icons set) is generated from it, so the app, the installer and the
// README cannot drift apart.
//
// Run after changing the master:  node scripts/generate-logo.mjs
//
// This replaces an earlier procedural renderer that drew a "T" from signed
// distance fields; it emitted an effectively blank tile at every size, so the
// shipped app had a blank icon everywhere.
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

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

// ---- Master image decode --------------------------------------------------

// Every asset is derived from the master artwork at the repository root rather
// than drawn procedurally. The previous signed-distance-field renderer emitted
// an effectively blank tile at every size, so the app shipped an empty icon.
//
// Decoding is limited to what the master actually is - 8-bit RGBA, no
// interlacing - and fails loudly on anything else instead of guessing.

const MASTER = "termigo.png";

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${MASTER}: not a PNG`);
  let width = 0;
  let height = 0;
  const idat = [];
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `${MASTER}: need 8-bit RGBA, non-interlaced (got depth=${depth} colorType=${colorType} interlace=${interlace})`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    i += 12 + len;
  }
  if (!width || !height) throw new Error(`${MASTER}: missing IHDR`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  // Undo the per-scanline filters (PNG spec 9.2). `a` is the pixel to the
  // left, `b` above, `c` above-left.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`${MASTER}: bad filter ${filter} on row ${y}`);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

// ---- Background removal ---------------------------------------------------

const WHITE_CUTOFF = 236;

// The master is a rounded square on an opaque white field. Shipping it as-is
// puts a white box on the dark titlebar and a white fringe around the taskbar
// icon, so clear the margin OUTSIDE the mark.
//
// A flood fill from the corners is used rather than a global "white is
// transparent" rule: the terminal prompt glyph inside the mark is also white
// and must survive.
function cutBackground(img) {
  const { width, height, data } = img;
  const outside = new Uint8Array(width * height);
  const stack = [];
  const consider = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (outside[i]) return;
    const p = i * 4;
    if (Math.min(data[p], data[p + 1], data[p + 2]) < WHITE_CUTOFF) return;
    outside[i] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < width; x++) {
    consider(x, 0);
    consider(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    consider(0, y);
    consider(width - 1, y);
  }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    consider(x - 1, y);
    consider(x + 1, y);
    consider(x, y - 1);
    consider(x, y + 1);
  }
  // Feather the boundary by alpha so the rounded corners do not stair-step.
  for (let i = 0; i < width * height; i++) {
    if (!outside[i]) continue;
    const p = i * 4;
    const brightness = Math.min(data[p], data[p + 1], data[p + 2]);
    data[p + 3] =
      brightness >= 252
        ? 0
        : Math.min(255, Math.round(((252 - brightness) * 255) / (252 - WHITE_CUTOFF)));
  }
  return img;
}

// Pad to a square canvas so no generated icon distorts the aspect ratio.
function squarize(img) {
  const { width, height, data } = img;
  if (width === height) return img;
  const side = Math.max(width, height);
  const out = Buffer.alloc(side * side * 4); // transparent
  const ox = (side - width) >> 1;
  const oy = (side - height) >> 1;
  for (let y = 0; y < height; y++) {
    data.copy(out, ((y + oy) * side + ox) * 4, y * width * 4, (y + 1) * width * 4);
  }
  return { width: side, height: side, data: out };
}

// ---- Resampling -----------------------------------------------------------

// Area-average resample, computed on premultiplied alpha so transparent pixels
// cannot bleed their colour into the edges of the mark.
function resample(img, size) {
  const { width, height, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;
  for (let y = 0; y < size; y++) {
    const y0 = y * scaleY;
    const y1 = Math.min(height, (y + 1) * scaleY);
    for (let x = 0; x < size; x++) {
      const x0 = x * scaleX;
      const x1 = Math.min(width, (x + 1) * scaleX);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.max(Math.ceil(y1), Math.floor(y0) + 1); sy++) {
        if (sy >= height) break;
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.max(Math.ceil(x1), Math.floor(x0) + 1); sx++) {
          if (sx >= width) break;
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const p = (sy * width + sx) * 4;
          const alpha = data[p + 3] / 255;
          r += data[p] * alpha * w;
          g += data[p + 1] * alpha * w;
          b += data[p + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const i = (y * size + x) * 4;
      if (a <= 0 || weight <= 0) {
        out[i + 3] = 0;
        continue;
      }
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round((a / weight) * 255);
    }
  }
  return out;
}

const master = squarize(cutBackground(decodePng(readFileSync(MASTER))));

const renderCache = new Map();

// Same signature the encoders below already expect: RGBA bytes for one size.
function render(size) {
  const hit = renderCache.get(size);
  if (hit) return hit;
  const rgba = resample(master, size);
  renderCache.set(size, rgba);
  return rgba;
}

// ---- ICO / ICNS -----------------------------------------------------------

// Classic 32-bit DIB entry for an ICO: BITMAPINFOHEADER (40 bytes), BGRA
// pixel rows bottom-up, then a 1bpp AND mask. RC.EXE on this toolchain
// rejects PNG-compressed ICO entries with RC2176, so we emit raw DIBs.
function dibFor(size) {
  const rgba = render(size);
  const rowBytes = size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;

  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0); // biSize
  bih.writeInt32LE(size, 4); // biWidth
  bih.writeInt32LE(size * 2, 8); // biHeight = pixels + AND mask
  bih.writeUInt16LE(1, 12); // biPlanes
  bih.writeUInt16LE(32, 14); // biBitCount
  bih.writeUInt32LE(0, 16); // biCompression = BI_RGB
  bih.writeUInt32LE(0, 20); // biSizeImage (0 is allowed for BI_RGB)

  // Pixel data, bottom-up, BGRA.
  const pixels = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const si = (srcY * size + x) * 4;
      const di = y * rowBytes + x * 4;
      pixels[di] = rgba[si + 2]; // B
      pixels[di + 1] = rgba[si + 1]; // G
      pixels[di + 2] = rgba[si]; // R
      pixels[di + 3] = rgba[si + 3]; // A
    }
  }

  // AND mask: 1 = transparent.
  const andMask = Buffer.alloc(andRowBytes * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] < 128) {
        andMask[y * andRowBytes + Math.floor(x / 8)] |= 0x80 >> (x % 8);
      }
    }
  }

  return Buffer.concat([bih, pixels, andMask]);
}

function encodeIco(sizes) {
  const images = sizes.map((s) => {
    const dib = dibFor(s);
    if (dib.readUInt32LE(0) !== 40) {
      throw new Error(`dibFor(${s}) missing BITMAPINFOHEADER`);
    }
    return { s, dib };
  });
  console.log("encodeIco sizes:", images.map((i) => i.s + ":" + i.dib.length).join(", "));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  // Standard ICO layout: ICONDIR, then ICONDIRENTRYs (16 bytes each), then
  // the image data. All entries first, then all DIBs — so dwImageOffset
  // matches the real byte position of each image.
  const entries = [];
  const datas = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.s >= 256 ? 0 : img.s;
    e[1] = img.s >= 256 ? 0 : img.s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.dib.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.dib.length;
    entries.push(e);
    datas.push(img.dib);
  }
  return Buffer.concat([header, ...entries, ...datas]);
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

// In-app logo (AI mini window, terminal block watermark, agent icon).
// NOTE: `termigo.png` is the master input and is deliberately not written here.
writeFileSync("public/logo.png", encodePng(256, 256, render(256)));

// Tauri icons.
writeFileSync(`${iconsDir}/32x32.png`, encodePng(32, 32, render(32)));
writeFileSync(`${iconsDir}/64x64.png`, encodePng(64, 64, render(64)));
writeFileSync(`${iconsDir}/128x128.png`, encodePng(128, 128, render(128)));
writeFileSync(`${iconsDir}/128x128@2x.png`, encodePng(256, 256, render(256)));
writeFileSync(`${iconsDir}/icon.png`, encodePng(512, 512, render(512)));
writeFileSync(`${iconsDir}/icon.ico`, encodeIco([16, 24, 32, 48, 64, 128]));
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

console.log(`Generated Termigo brand assets from ${MASTER}:`);
for (const f of [
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
