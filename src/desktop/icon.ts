import { deflateSync } from "node:zlib";

// Dark square with four severity-colored bars (critical → low), matching the app's palette.
const BG: [number, number, number] = [13, 17, 23];
const BARS: [number, number, number][] = [
  [248, 81, 73],
  [240, 136, 62],
  [210, 153, 34],
  [63, 185, 80],
];
const BAR_WIDTHS = [1, 0.8, 0.62, 0.45];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Renders the app icon as an RGBA PNG of the given size. Dependency-free so main and build scripts share it.
 * `transparent` drops the dark square (tray icon: bars alone read better on a dark taskbar).
 */
export function makeIconPng(size: number, opts: { transparent?: boolean } = {}): Buffer {
  const bgAlpha = opts.transparent ? 0 : 255;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const pad = Math.round(size * 0.16);
  const gap = Math.max(1, Math.round(size * 0.06));
  const barH = (size - 2 * pad - 3 * gap) / 4;
  const inner = size - 2 * pad;

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    const yy = y - pad;
    const bar = Math.floor(yy / (barH + gap));
    const inBar = yy >= 0 && bar < 4 && yy - bar * (barH + gap) < barH;
    for (let x = 0; x < size; x++) {
      const onBar = inBar && x >= pad && x < pad + inner * BAR_WIDTHS[bar];
      const color = onBar ? BARS[bar] : BG;
      const i = y * stride + 1 + x * 4;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
      raw[i + 3] = onBar ? 255 : bgAlpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
