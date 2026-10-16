// One-time helper: turns a logo screenshot (dark rounded tile on a grey background) into the app icon.
// Crops to the tile, makes the grey outside its rounded corners transparent, writes build/icon.png (512)
// and src/ui/logo.png (64, for the header).
// Usage: node scripts/run-electron.mjs scripts/import-logo.cjs <source.png>
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const src = process.argv[process.argv.length - 1];
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(src);
  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const px = (x, y) => {
    const i = (y * W + x) * 4;
    return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]];
  };

  // Background = the corner color; the tile is clearly darker. Bounding box of "not background".
  const bg = px(2, 2);
  const bgLum = lum(bg[0], bg[1], bg[2]);
  const isBg = (r, g, b) => Math.abs(lum(r, g, b) - bgLum) < 6 && Math.max(r, g, b) - Math.min(r, g, b) < 10;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      if (!isBg(r, g, b)) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  // Square crop around the tile.
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const cx = Math.round((minX + maxX) / 2), cy = Math.round((minY + maxY) / 2);
  const x0 = Math.max(0, cx - Math.floor(side / 2)), y0 = Math.max(0, cy - Math.floor(side / 2));
  const s = Math.min(side, W - x0, H - y0);

  // Copy crop, background-grey → transparent (soft edge for anti-aliased pixels near the tile corners).
  const out = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const [r, g, b, a] = px(x0 + x, y0 + y);
      const o = (y * s + x) * 4;
      out[o] = b; out[o + 1] = g; out[o + 2] = r;
      out[o + 3] = isBg(r, g, b) ? 0 : a;
    }
  const cropped = nativeImage.createFromBitmap(out, { width: s, height: s });

  const root = path.resolve(__dirname, "..");
  fs.writeFileSync(path.join(root, "build", "icon.png"), cropped.resize({ width: 512, height: 512, quality: "best" }).toPNG());
  fs.writeFileSync(path.join(root, "src", "ui", "logo.png"), cropped.resize({ width: 64, height: 64, quality: "best" }).toPNG());
  console.log(`source ${W}x${H}, tile ${minX},${minY}-${maxX},${maxY}, crop ${s}px → build/icon.png (512), src/ui/logo.png (64)`);
  app.quit();
});
