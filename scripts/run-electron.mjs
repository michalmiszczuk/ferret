// Starts Electron with ELECTRON_RUN_AS_NODE removed. VS Code (and Claude Code inside it) sets that
// variable in its terminals, which makes electron.exe behave like plain Node and breaks the app.
import { spawn } from "node:child_process";
import electron from "electron"; // under plain Node this resolves to the electron binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, process.argv.slice(2), { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
