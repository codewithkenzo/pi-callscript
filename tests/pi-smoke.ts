import { spawn } from "node:child_process";

const launch = (extension: string) =>
  new Promise<{ output: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(
      "node",
      [
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "-e",
        extension,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ output, exitCode }));
    child.stdin.end(`${JSON.stringify({ type: "get_commands" })}\n`);
  });

for (const extension of ["./src/index.ts", "./dist/index.mjs"]) {
  const { output, exitCode } = await launch(extension);
  if (exitCode !== 0) throw new Error(`Pi RPC exited with ${exitCode} for ${extension}`);
  if (!output.includes('"name":"callscript"'))
    throw new Error(`CallScript command was not registered from ${extension}`);
}

process.stdout.write("Pi RPC source and build load ok\n");
