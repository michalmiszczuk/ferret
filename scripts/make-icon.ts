import { promises as fs } from "node:fs";
import path from "node:path";
import { makeIconPng } from "../src/desktop/icon";

const out = path.join(process.cwd(), "build", "icon.png");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, makeIconPng(512));
console.log(`Wrote ${out}`);
