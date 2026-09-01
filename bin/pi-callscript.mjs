#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, "skill", "pi-callscript", "SKILL.md");
const target = join(homedir(), ".agents", "skills", "pi-callscript", "SKILL.md");
const argument = process.argv[2];

if (argument === "--help" || argument === "-h") {
  process.stdout.write("Install the optional pi-callscript agent skill.\n\nUsage: pi-callscript\n");
  process.exit(0);
}

if (argument !== undefined) {
  process.stderr.write(`Unknown argument: ${argument}\nRun pi-callscript --help for usage.\n`);
  process.exit(1);
}

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
process.stdout.write(`Installed pi-callscript skill → ${target}\n`);
