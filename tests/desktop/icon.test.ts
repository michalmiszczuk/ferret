import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeIconPng } from "../../src/desktop/icon";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG reader for the test: returns width, height and the concatenated, inflated IDAT data. */
function readPng(buf: Buffer) {
  expect(buf.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    types.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(6); // RGBA
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  return { width, height, types, raw: inflateSync(Buffer.concat(idat)) };
}

describe("makeIconPng", () => {
  it.each([16, 32, 256])("produces a valid %ipx RGBA PNG", (size) => {
    const png = readPng(makeIconPng(size));
    expect(png.width).toBe(size);
    expect(png.height).toBe(size);
    expect(png.types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(png.raw.length).toBe((size * 4 + 1) * size);
  });

  it("can render the bars on a transparent background (tray icon on a dark taskbar)", () => {
    const size = 32;
    const { raw } = readPng(makeIconPng(size, { transparent: true }));
    const alphaAt = (x: number, y: number) => raw[y * (size * 4 + 1) + 1 + x * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(Math.round(size * 0.25), Math.round(size * 0.2))).toBe(255);
  });

  it("paints a dark background corner and a red top bar", () => {
    const size = 64;
    const { raw } = readPng(makeIconPng(size));
    const px = (x: number, y: number) => {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    };
    expect(px(0, 0)).toEqual([13, 17, 23, 255]);
    expect(px(Math.round(size * 0.25), Math.round(size * 0.2))).toEqual([248, 81, 73, 255]);
  });
});
