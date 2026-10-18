// Dev helper: preview server (port 4479) with a seeded review AND a mock ClickUp (token preconfigured),
// so the Send to ClickUp dialog shows the people picker. Ctrl+C to stop.
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server/index";

const mock = http.createServer((req, res) => {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const route = `${req.method} ${req.url}`;
  if (route === "GET /v2/team") {
    return send(200, { teams: [{ id: "9012", name: "Synergy", members: [
      { user: { id: 11, username: "Kuba Skibinski", email: "kuba@synergycodes.com" } },
      { user: { id: 12, username: "Jim Meryn", email: "jim@synergycodes.com" } },
      { user: { id: 13, username: "Karolina Nowak", email: "karolina@synergycodes.com" } },
    ] }] });
  }
  if (route?.startsWith("POST /v3/") && route.includes("/docs")) return send(201, { id: "doc42" });
  if (route?.includes("direct_message")) return send(201, { data: { id: "ch77" } });
  if (route?.includes("/messages")) return send(201, { data: { id: "m1" } });
  send(200, { user: { username: "michal" } });
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
process.env.REVIEW_APP_CLICKUP_API = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-cuui-"));
await fs.writeFile(path.join(home, "clickup.json"), JSON.stringify({ token: "pk_test", user: "michal" }), "utf8");
const srv = await startServer({ port: 4479, home, log: () => {}, uiDir: path.resolve("dist/ui") });
await srv.store.create({
  repoRoot: process.cwd(),
  scope: { kind: "files", target: ["package.json"] },
  summary: "Seeded",
  findings: [{ severity: "medium", title: "Seeded finding", body: "b", category: "bug", file: "package.json", lineStart: 3, lineEnd: 3, snippet: '  "version": "0.1.0",' }],
});
console.log(`UI at ${srv.url} (home ${home})`);
