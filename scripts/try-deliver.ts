// Dev helper: shows the running Claude sessions Ferret would list, and the courier run it would spawn.
// (A real delivery was verified by hand: a headless SendMessage ping reached the becktv session and was acknowledged.)
import { listLiveSessions } from "../src/server/claude-sessions";
import { buildDeliverRun } from "../src/server/deliver";
import { buildClaudeArgs } from "../src/server/claude-runner";

console.log("live sessions:", await listLiveSessions());
const run = buildDeliverRun("workflowbuilder-5c", "/apply-review r_1 f1 fix it", { sandboxDir: "C:/sandbox" });
console.log("courier cwd:", run.cwd, "| tools:", run.allowedTools, "| model:", run.model);
console.log("args:", buildClaudeArgs(run).filter((a) => !a.startsWith("Use the SendMessage")).slice(2, 16));
