const fs = require('fs');
const path = require('path');

const baseDir = path.resolve('extensions/database-explorer');
const outPath = path.resolve('database-explorer.zip');

// Simple zip creation using Node.js built-in zlib
const files = [
  'manifest.json',
  'main.js',
  'README.md',
  'lib/sql-wasm.js',
  'lib/sql-wasm.b64',
];

const { Deflate } = require('zlib');
const { promisify } = require('util');
const deflate = promisify(Deflate);

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

async function createZip() {
  const entries = [];
  let totalSize = 0;

  for (const file of files) {
    const fullPath = path.join(baseDir, file);
    const data = fs.readFileSync(fullPath);
    const name = file.replace(/\\/g, '/');
    const crc = crc32(data);
    const compressed = await deflate(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // compression (deflate)
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0, 12); // date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(compressed.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    entries.push({ header, data: compressed, name, uncompressedSize: data.length });
    totalSize += 30 + name.length + compressed.length;
  }

  const centralDirSize = entries.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const totalZipSize = totalSize + centralDirSize + 22;

  const zip = Buffer.alloc(totalZipSize);
  let offset = 0;

  // Local file headers
  for (const entry of entries) {
    entry.header.copy(zip, offset);
    offset += 30;
    zip.write(entry.name, offset);
    offset += entry.name.length;
    entry.data.copy(zip, offset);
    offset += entry.data.length;
  }

  // Central directory
  let centralOffset = offset;
  for (const entry of entries) {
    const centralHeader = Buffer.alloc(46 + entry.name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // compression
    centralHeader.writeUInt16LE(0, 12); // time
    centralHeader.writeUInt16LE(0, 14); // date
    centralHeader.writeUInt32LE(entry.crc || crc32(Buffer.from(entry.data)), 16);
    // Actually we need the original crc
    const originalData = fs.readFileSync(path.join(baseDir, entry.name));
    const originalCrc = crc32(originalData);
    centralHeader.writeUInt32LE(originalCrc, 16);
    centralHeader.writeUInt32LE(originalData.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(entry.name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(centralOffset, 42); // offset
    centralHeader.write(entry.name, 46);
    centralHeader.copy(zip, offset);
    offset += centralHeader.length;
  }

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(totalSize, 16);
  eocd.writeUInt32LE(centralOffset, 20);
  eocd.copy(zip, offset);

  fs.writeFileSync(outPath, zip);
  console.log('Created zip:', outPath, 'size:', zip.length, 'bytes');
}

createZip().catch(console.error);
