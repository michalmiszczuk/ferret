import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from "electron";
import path from "node:path";
import { createClaudeIntegration } from "../server/claude";
import { defaultHome, startServer, type RunningServer } from "../server/index";
import type { StoreEvent } from "../shared/api-types";
import { countBySeverity } from "../shared/findings";
import { makeIconPng } from "./icon";
import {
  APP_ID, closeAction, isAppUrl, isSafeExternal, loginItemPlan, PROTOCOL, reviewNotificationText, shouldRegisterProtocol,
  startedHidden, startupErrorMessage, unpackedPath,
} from "./logic";
import { loadSettings, saveSettings, type DesktopSettings } from "./settings";

const PORT = 4477;
const settingsFile = path.join(defaultHome(), "desktop.json");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: RunningServer | null = null;
let settings: DesktopSettings = { openAtLogin: false };
let quitting = false;
let sessionEnding = false;

// The Ferret logo (build/icon.png, shipped in the app); the generated bars icon is the fallback.
const logo = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png"));
const icon = (size: number) =>
  logo.isEmpty() ? nativeImage.createFromBuffer(makeIconPng(size)) : logo.resize({ width: size, height: size, quality: "best" });

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function registerProtocol(): void {
  if (!shouldRegisterProtocol(Boolean(process.defaultApp), process.env)) return;
  // In dev (`electron .`) Windows must be told to launch electron.exe with our app path.
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function createWindow(url: string, hidden: boolean): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: "Ferret",
    backgroundColor: "#1e1e1e",
    icon: icon(256),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Links (Open in VS Code, markdown links) go to the OS; the window only ever shows our own UI.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isSafeExternal(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (isAppUrl(target, PORT)) return;
    e.preventDefault();
    if (isSafeExternal(target)) void shell.openExternal(target);
  });

  win.on("close", (e) => {
    if (closeAction({ quitting, sessionEnding }) === "hide") {
      e.preventDefault();
      win?.hide();
    }
  });
  // Windows shutdown / sign-out: never hold it up by hiding to the tray.
  win.on("session-end", () => {
    sessionEnding = true;
  });
  win.once("ready-to-show", () => {
    if (!hidden) showWindow();
  });
  void win.loadURL(url);
}

function buildTrayMenu(): Menu {
  const login = loginItemPlan(app.isPackaged, settings.openAtLogin);
  const loginLabel = process.platform === "darwin" ? "Start at login" : "Start with Windows";
  return Menu.buildFromTemplate([
    { label: "Open Ferret", click: showWindow },
    { type: "separator" },
    {
      label: login.enabled ? loginLabel : `${loginLabel} (installed app only)`,
      type: "checkbox",
      enabled: login.enabled,
      checked: login.checked,
      click: (item) => void setOpenAtLogin(item.checked),
    },
    { label: "Install Claude integration…", click: () => void installIntegration() },
    { type: "separator" },
    { label: "Quit", click: quit },
  ]);
}

function createTray(): void {
  // 32px marked @2x so Windows shows it crisp at 16 DIP (and larger on high-DPI).
  const trayImage = logo.isEmpty()
    ? nativeImage.createFromBuffer(makeIconPng(32, { transparent: true }), { scaleFactor: 2 })
    : nativeImage.createFromBuffer(logo.resize({ width: 32, height: 32, quality: "best" }).toPNG(), { scaleFactor: 2 });
  tray = new Tray(trayImage);
  tray.setToolTip("Ferret");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showWindow);
}

function applyLoginItem(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
}

async function setOpenAtLogin(on: boolean): Promise<void> {
  if (!loginItemPlan(app.isPackaged, on).enabled) return; // dev run: never save a choice Windows doesn't have
  settings = { ...settings, openAtLogin: on };
  applyLoginItem(on);
  try {
    await saveSettings(settingsFile, settings);
  } catch (err) {
    dialog.showErrorBox("Could not save settings", err instanceof Error ? err.message : String(err));
  }
  tray?.setContextMenu(buildTrayMenu());
}

const claudeIntegration = createClaudeIntegration({
  skillsDir: unpackedPath(path.join(app.getAppPath(), "skills")),
  mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
});

async function installIntegration(): Promise<void> {
  try {
    const res = await claudeIntegration.connect();
    await dialog.showMessageBox({
      type: res.ok ? "info" : "warning",
      title: "Claude integration",
      message: res.ok ? "Claude connected" : "Claude integration",
      detail: res.message,
    });
  } catch (err) {
    dialog.showErrorBox("Claude integration failed", err instanceof Error ? err.message : String(err));
  }
}

function onStoreChange(e: StoreEvent): void {
  if (e.type !== "review-created" || !win || !server) return;
  const wasVisible = win.isVisible();
  showWindow();
  if (!wasVisible && Notification.isSupported()) {
    const review = server.store.get(e.reviewId);
    const n = new Notification({
      title: "New review",
      body: review ? reviewNotificationText(countBySeverity(review.findings)) : e.reviewId,
      icon: icon(64),
    });
    n.on("click", showWindow);
    n.show();
  }
}

async function start(): Promise<void> {
  settings = await loadSettings(settingsFile);
  // Re-apply the saved choice so Windows matches the tick (e.g. after a reinstall moved the exe).
  if (loginItemPlan(app.isPackaged, settings.openAtLogin).applyOnStart) applyLoginItem(settings.openAtLogin);
  try {
    server = await startServer({
      port: PORT,
      uiDir: unpackedPath(path.join(app.getAppPath(), "dist", "ui")),
      claude: claudeIntegration,
      openExternal: (url) => shell.openExternal(url),
    });
  } catch (err) {
    dialog.showErrorBox("Ferret could not start", startupErrorMessage(err, PORT));
    app.exit(1);
    return;
  }
  server.store.on("change", onStoreChange);
  createWindow(server.url, startedHidden(process.argv));
  createTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  registerProtocol();
  app.on("second-instance", () => showWindow()); // Start menu relaunch or review-app://open
  app.on("open-url", (e) => {
    // macOS delivers review-app:// here
    e.preventDefault();
    showWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    // keep running in the tray
  });
  app.on("will-quit", () => {
    void server?.close();
  });
  void app.whenReady().then(start);
}
