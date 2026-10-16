import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeIntegration } from "../../src/server/claude";
import { startServer, type RunningServer } from "../../src/server/index";
import { tmpDir } from "../helpers";

let srv: RunningServer;
let claude: { status: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  claude = {
    status: vi.fn(async () => ({ connected: false, skillsInstalled: false, mcpRegistered: false })),
    connect: vi.fn(async () => ({ ok: true, message: "Claude connected." })),
  };
  srv = await startServer({ port: 0, home: await tmpDir("review-app-home-"), log: () => {}, claude: claude as ClaudeIntegration });
});
afterEach(async () => {
  await srv.close();
});

describe("/api/claude", () => {
  it("GET status reports the integration state", async () => {
    const res = await fetch(`${srv.url}/api/claude/status`);
    expect(await res.json()).toEqual({ connected: false, skillsInstalled: false, mcpRegistered: false });
  });

  it("POST connect runs the setup when sent as JSON from the app", async () => {
    const res = await fetch(`${srv.url}/api/claude/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Claude connected." });
    expect(claude.connect).toHaveBeenCalledTimes(1);
  });

  it("POST connect refuses non-JSON requests (a web page's simple cross-site form post)", async () => {
    const res = await fetch(`${srv.url}/api/claude/connect`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
    expect(claude.connect).not.toHaveBeenCalled();
  });

  it("is absent when the server runs without an integration (404)", async () => {
    const plain = await startServer({ port: 0, home: await tmpDir("review-app-home-"), log: () => {} });
    try {
      expect((await fetch(`${plain.url}/api/claude/status`)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
