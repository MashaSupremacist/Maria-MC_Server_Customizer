/**
 * generate-icon.mjs
 *
 * Generates apps/desktop/build/icon.png (256x256) and icon.ico (multi-size)
 * for electron-builder. Draws a compact green-and-black "server block" icon
 * matching the app theme (no gradients, per the design requirements).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(dirname, '../apps/desktop/build');
fs.mkdirSync(buildDir, { recursive: true });

const SIZE = 256;

// Theme palette
const COLORS = {
  background: [5, 8, 5], // --background
  panel: [16, 24, 16], // --panel-raised
  border: [32, 53, 36], // --border
  accent: [57, 230, 109], // --accent
  accentDark: [24, 96, 46],
  text: [232, 245, 235], // --text
  muted: [141, 160, 149], // --muted
};

// RGBA canvas
const img = Buffer.alloc(SIZE * SIZE * 4);

function setPixel(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  img[i] = r;
  img[i + 1] = g;
  img[i + 2] = b;
  img[i + 3] = a;
}

function fillRect(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPixel(x, y, color);
    }
  }
}

function drawPixelArt(sprite, x0, y0, scale, palette) {
  for (let sy = 0; sy < sprite.length; sy++) {
    for (let sx = 0; sx < sprite[sy].length; sx++) {
      const ch = sprite[sy][sx];
      if (ch === ' ') continue;
      const color = palette[ch];
      if (!color) continue;
      fillRect(x0 + sx * scale, y0 + sy * scale, scale, scale, color);
    }
  }
}

// A pixel-art "server block": a cube with a green front face,
// darker sides, and a subtle border. 16x16 grid scaled to 8 = 128px,
// centered with margins.
const sprite = [
  '                ',
  '   aaaaaaaaaa   ',
  '  a          a  ',
  ' a    bbbb    a ',
  ' a   b    b   a ',
  ' a   b    b   a ',
  ' a   b    b   a ',
  ' a   b    b   a ',
  ' a   bbbbbb   a ',
  ' a            a ',
  ' a            a ',
  '  a          a  ',
  '   aaaaaaaaaa   ',
  '                ',
  '                ',
  '                ',
];

// Palette: a = border/outline (dark green), b = accent face (green),
// interior uses accent-dark for shading. Background transparent.
const palette = {
  a: COLORS.border,
  b: COLORS.accent,
};

// Fill background (rounded-ish square panel behind the block).
fillRect(24, 24, SIZE - 48, SIZE - 48, COLORS.panel);
// Border around panel
for (let i = 0; i < 4; i++) {
  fillRect(24 + i, 24 + i, SIZE - 48 - i * 2, 1, COLORS.border);
  fillRect(24 + i, SIZE - 24 - i - 1, SIZE - 48 - i * 2, 1, COLORS.border);
  fillRect(24 + i, 24 + i, 1, SIZE - 48 - i * 2, COLORS.border);
  fillRect(SIZE - 24 - i - 1, 24 + i, 1, SIZE - 48 - i * 2, COLORS.border);
}

// Draw the block centered.
const scale = 8;
const spriteW = sprite[0].length * scale;
const spriteH = sprite.length * scale;
const x0 = Math.floor((SIZE - spriteW) / 2);
const y0 = Math.floor((SIZE - spriteH) / 2);
drawPixelArt(sprite, x0, y0, scale, palette);

// Small "power" dot in the accent corner to echo the app's status lights.
fillRect(SIZE - 44, 44, 10, 10, COLORS.accentDark);

// ---- PNG encoding (RGBA, no interlace) ----
function encodePng(width, height, rgba) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const crc = zlib.crc32
      ? null
      : crc32(Buffer.concat([typeBuf, data]));
    if (zlib.crc32) {
      crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
    } else {
      crcBuf.writeUInt32BE(crc >>> 0);
    }
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC32 implementation (zlib may not expose crc32 on all versions)
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

// ---- ICO encoding ----
function encodeIco(sizes) {
  const images = sizes.map((s) => {
    // Downscale the 256x256 canvas to s x s with simple box sampling.
    const small = Buffer.alloc(s * s * 4);
    const ratio = SIZE / s;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          n = 0;
        const x0 = Math.floor(x * ratio);
        const x1 = Math.floor((x + 1) * ratio);
        const y0 = Math.floor(y * ratio);
        const y1 = Math.floor((y + 1) * ratio);
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const i = (py * SIZE + px) * 4;
            r += img[i];
            g += img[i + 1];
            b += img[i + 2];
            a += img[i + 3];
            n++;
          }
        }
        if (n === 0) n = 1;
        const i = (y * s + x) * 4;
        small[i] = Math.round(r / n);
        small[i + 1] = Math.round(g / n);
        small[i + 2] = Math.round(b / n);
        small[i + 3] = Math.round(a / n);
      }
    }
    // BMP (BITMAPINFOHEADER + BGRA + AND mask) inside ICO
    const headerSize = 40;
    const andStride = Math.ceil(s / 32) * 4;
    const xorSize = s * s * 4;
    const andSize = andStride * s;
    const bmp = Buffer.alloc(headerSize + xorSize + andSize);
    bmp.writeUInt32LE(headerSize, 0);
    bmp.writeInt32LE(s, 4);
    bmp.writeInt32LE(s * 2, 8); // height = 2x for AND mask
    bmp.writeUInt16LE(1, 12);
    bmp.writeUInt16LE(32, 14);
    bmp.writeUInt32LE(0, 16);
    bmp.writeUInt32LE(xorSize + andSize, 20);
    // XOR: BGRA order
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const src = (y * s + x) * 4;
        const dst = headerSize + (y * s + x) * 4;
        bmp[dst] = small[src + 2]; // B
        bmp[dst + 1] = small[src + 1]; // G
        bmp[dst + 2] = small[src]; // R
        bmp[dst + 3] = small[src + 3]; // A
      }
    }
    // AND mask: all zeros (alpha is in the XOR bitmap)
    return {
      width: s >= 256 ? 0 : s,
      height: s >= 256 ? 0 : s,
      data: bmp,
    };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const im of images) {
    const e = Buffer.alloc(16);
    e[0] = im.width;
    e[1] = im.height;
    e[2] = 0; // colors
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(im.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.data.length;
    entries.push(e);
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const png256 = encodePng(SIZE, SIZE, img);
fs.writeFileSync(path.join(buildDir, 'icon.png'), png256);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco([256, 128, 64, 48, 32, 16]));
console.log('icon.png + icon.ico written to', buildDir);
