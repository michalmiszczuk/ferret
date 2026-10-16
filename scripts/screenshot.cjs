// Dev-only: captures the running review-app UI to a PNG so the look can be checked without a browser.
// Usage: npm run screenshot -- <out.png>   (env SCREENSHOT_URL overrides the page, default http://127.0.0.1:4477/)
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const out = process.argv[process.argv.length - 1];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false });
  await win.loadURL(process.env.SCREENSHOT_URL || "http://127.0.0.1:4477/");
  await new Promise((r) => setTimeout(r, 1500));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  console.log(`Wrote ${out}`);
  app.quit();
});
