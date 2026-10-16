import { describe, expect, it } from "vitest";
import {
  closeAction, findProtocolUrl, isAppUrl, isSafeExternal, loginItemPlan, reviewNotificationText, shouldRegisterProtocol,
  startedHidden, startupErrorMessage, unpackedPath,
} from "../../src/desktop/logic";

describe("findProtocolUrl", () => {
  it("finds the review-app link among Windows second-instance args (case-insensitive)", () => {
    const argv = ["C:\\Apps\\review-app.exe", "--allow-file-access-from-files", "REVIEW-APP://open"];
    expect(findProtocolUrl(argv)).toBe("REVIEW-APP://open");
  });

  it("returns undefined when absent", () => {
    expect(findProtocolUrl(["review-app.exe", "--hidden"])).toBeUndefined();
  });
});

describe("startedHidden", () => {
  it("is true for the login-item launch", () => {
    expect(startedHidden(["review-app.exe", "--hidden"])).toBe(true);
  });

  it("is false for a normal launch", () => {
    expect(startedHidden(["review-app.exe"])).toBe(false);
  });

  it("is false when launched via review-app:// even if --hidden is present", () => {
    expect(startedHidden(["review-app.exe", "--hidden", "review-app://open"])).toBe(false);
  });
});

describe("isAppUrl", () => {
  it("accepts the app's own origin on the right port", () => {
    expect(isAppUrl("http://127.0.0.1:4477/r/r_abc123", 4477)).toBe(true);
    expect(isAppUrl("http://localhost:4477/", 4477)).toBe(true);
  });

  it("rejects other ports, hosts and schemes", () => {
    expect(isAppUrl("http://127.0.0.1:5173/", 4477)).toBe(false);
    expect(isAppUrl("https://127.0.0.1:4477/", 4477)).toBe(false);
    expect(isAppUrl("http://evil.example:4477/", 4477)).toBe(false);
    expect(isAppUrl("vscode://file/C:/a.ts:1", 4477)).toBe(false);
    expect(isAppUrl("not a url", 4477)).toBe(false);
  });
});

describe("isSafeExternal", () => {
  it("allows http, https and vscode links", () => {
    expect(isSafeExternal("https://github.com")).toBe(true);
    expect(isSafeExternal("http://example.com")).toBe(true);
    expect(isSafeExternal("vscode://file/C:/Users/Micha%C5%82/a.ts:3")).toBe(true);
  });

  it("refuses javascript:, file: and garbage", () => {
    expect(isSafeExternal("javascript:alert(1)")).toBe(false);
    expect(isSafeExternal("file:///C:/Windows/system32/calc.exe")).toBe(false);
    expect(isSafeExternal("::::")).toBe(false);
  });
});

describe("reviewNotificationText", () => {
  it("formats the severity counts", () => {
    expect(reviewNotificationText({ critical: 2, high: 3, medium: 4, low: 1 })).toBe("🔴 2 · 🟠 3 · 🟡 4 · 🟢 1");
  });
});

describe("unpackedPath", () => {
  it("redirects paths inside app.asar to app.asar.unpacked (Windows and POSIX separators)", () => {
    expect(unpackedPath("C:\\Apps\\review-app\\resources\\app.asar\\dist\\ui")).toBe(
      "C:\\Apps\\review-app\\resources\\app.asar.unpacked\\dist\\ui",
    );
    expect(unpackedPath("/Applications/review-app.app/Contents/Resources/app.asar/skills")).toBe(
      "/Applications/review-app.app/Contents/Resources/app.asar.unpacked/skills",
    );
  });

  it("leaves dev paths and already-unpacked paths alone", () => {
    expect(unpackedPath("C:\\Users\\me\\Code\\review-app\\dist\\ui")).toBe("C:\\Users\\me\\Code\\review-app\\dist\\ui");
    expect(unpackedPath("C:\\x\\app.asar.unpacked\\skills")).toBe("C:\\x\\app.asar.unpacked\\skills");
  });
});

describe("startupErrorMessage", () => {
  it("explains a busy port", () => {
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(startupErrorMessage(err, 4477)).toBe(
      "Port 4477 is in use. Is Ferret already running from a terminal? Close it and start the app again.",
    );
  });

  it("passes other errors through", () => {
    expect(startupErrorMessage(new Error("disk on fire"), 4477)).toBe("disk on fire");
    expect(startupErrorMessage("weird", 4477)).toBe("weird");
  });
});

describe("loginItemPlan", () => {
  it("installed app: menu enabled, tick = saved choice, and the saved choice is re-applied to Windows on start", () => {
    expect(loginItemPlan(true, true)).toEqual({ enabled: true, checked: true, applyOnStart: true });
    expect(loginItemPlan(true, false)).toEqual({ enabled: true, checked: false, applyOnStart: true });
  });

  it("dev run: disabled and unticked so it can never save a choice Windows doesn't have", () => {
    expect(loginItemPlan(false, true)).toEqual({ enabled: false, checked: false, applyOnStart: false });
  });
});

describe("shouldRegisterProtocol", () => {
  it("installed app always owns review-app://", () => {
    expect(shouldRegisterProtocol(false, {})).toBe(true);
  });

  it("dev run leaves the installed app's link alone unless explicitly asked", () => {
    expect(shouldRegisterProtocol(true, {})).toBe(false);
    expect(shouldRegisterProtocol(true, { REVIEW_APP_DEV_PROTOCOL: "1" })).toBe(true);
  });
});

describe("closeAction", () => {
  it("hides to the tray on a normal close", () => {
    expect(closeAction({ quitting: false, sessionEnding: false })).toBe("hide");
  });

  it("really closes when quitting or when Windows is shutting down / signing out", () => {
    expect(closeAction({ quitting: true, sessionEnding: false })).toBe("close");
    expect(closeAction({ quitting: false, sessionEnding: true })).toBe("close");
  });
});
