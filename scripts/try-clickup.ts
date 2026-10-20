// Dev helper: runs the ClickUp service against a local mock of the ClickUp API.
// Expected: token verified + saved; send = GET task → attachment (multipart, ferret-review .md) → comment; task
// remembered in recent; custom id without a URL and a bad token produce clear errors; task URL forms parse.
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createClickUp, formatTaskContext, parseTaskRef } from "../src/server/clickup";

const seen: string[] = [];
const server = http.createServer((req, res) => {
  const body: Buffer[] = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const text = Buffer.concat(body).toString("utf8");
    const route = `${req.method} ${req.url}`;
    seen.push(route);
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== "pk_test") return send(401, { err: "Token invalid" });
    if (route === "GET /v2/user") return send(200, { user: { username: "michal" } });
    if (route === "GET /v2/team") {
      return send(200, {
        teams: [{
          id: "9012",
          name: "Synergy",
          members: [
            { user: { id: 11, username: "Kuba Skibinski", email: "kuba@x.pl", initials: "KS" } },
            { user: { id: 12, username: "Jim Meryn", email: "jim@x.pl" } },
            { user: { id: 13, username: "Michał Miszczuk" } },
          ],
        }],
      });
    }
    if (route?.startsWith("GET /v2/task/abc123?") || route === "GET /v2/task/abc123") {
      return send(200, {
        id: "abc123",
        name: "Fix the sanitizer",
        url: "https://app.clickup.com/t/abc123",
        status: { status: "in progress" },
        markdown_description: "## Goal\nLabels must not render raw HTML.\n\n- strip tags\n- keep **bold**",
        attachments: [{ title: "spec.pdf", url: "https://x/spec.pdf" }],
      });
    }
    if (route === "GET /v2/task/abc123/comment") {
      return send(200, { comments: [{ comment_text: "Also cover the preview pane", user: { username: "kuba" }, date: "1792000000000" }] });
    }
    if (route === "POST /v2/task/abc123/attachment") {
      seen.push(`attachment has md: ${text.includes("ferret-review-") && text.includes("Ferret review")}`);
      return send(200, { id: "att1" });
    }
    if (route === "POST /v2/task/abc123/comment") {
      seen.push(`comment: ${(JSON.parse(text) as { comment_text: string }).comment_text.split("\n")[0]}`);
      return send(200, { id: "c1" });
    }
    if (route === "POST /v3/workspaces/9012/chat/channels/direct_message") {
      seen.push(`dm users: ${(JSON.parse(text) as { user_ids: string[] }).user_ids.join(",")}`);
      return send(201, { data: { id: "ch77" } });
    }
    if (route === "POST /v3/workspaces/9012/chat/channels/ch77/messages") {
      const c = (JSON.parse(text) as { content: string }).content;
      seen.push(`message: ${c.split("\n")[0]} | has task link: ${c.includes("app.clickup.com/t/abc123")}`);
      return send(201, { data: { id: "m1" } });
    }
    send(404, { err: "Team not authorized or task not found" });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.REVIEW_APP_CLICKUP_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log("parse url:", parseTaskRef("https://app.clickup.com/t/abc123"));
console.log("parse custom url:", parseTaskRef("https://app.clickup.com/t/9012/PROJ-12"));
console.log("parse bare custom id:", parseTaskRef("PROJ-12"));
console.log("parse garbage:", parseTaskRef("not a task!!"));

const home = await fs.mkdtemp(path.join(os.tmpdir(), "ferret-clickup-"));
const cu = createClickUp(path.join(home, "clickup.json"));
console.log("status before:", await cu.status());
console.log("bad token →", await cu.setToken("pk_wrong").catch((e: Error) => e.message));
console.log("setToken →", await cu.setToken("pk_test"));

const markdown = "# Ferret review · PR #203\n\n```json ferret-review\n{}\n```\n";
const result = await cu.send(parseTaskRef("https://app.clickup.com/t/abc123")!, {
  filename: "ferret-review-r_1.md",
  markdown,
  comment: "Ferret review · PR #203 · workflowbuilder\n🔴 1 · 🟠 0 · 🟡 2 · 🟢 4",
});
console.log("send →", result);
console.log("members →", (await cu.members()).map((w) => `${w.name}: ${w.members.map((m) => m.username).join(", ")}`));
console.log("taskContext →\n" + formatTaskContext(await cu.taskContext(parseTaskRef("https://app.clickup.com/t/abc123")!)));
await cu.dm("9012", 11, "Hi Kuba! I reviewed PR #203 with Ferret — 🔴 1 · 🟡 2.\n\nReview file is attached here: https://app.clickup.com/t/abc123", "Kuba Skibinski");
console.log("dm → sent");
console.log("custom id w/o url →", await cu.send(parseTaskRef("PROJ-12")!, { filename: "f.md", markdown, comment: "x" }).catch((e: Error) => e.message));
console.log("unknown task →", await cu.send(parseTaskRef("nope999")!, { filename: "f.md", markdown, comment: "x" }).catch((e: Error) => e.message));
console.log("status after:", await cu.status());
console.log("mock saw:", seen);
server.close();
await fs.rm(home, { recursive: true, force: true });
