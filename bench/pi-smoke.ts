const node = Bun.which("node");
if (node === null) throw new Error("Node.js is required for the Pi RPC smoke test");

for (const extension of ["./src/index.ts", "./dist/index.mjs"]) {
  const child = Bun.spawn(
    [
      node,
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
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );

  child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
  child.stdin.end();
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;

  if (exitCode !== 0) throw new Error(`Pi RPC exited with ${exitCode} for ${extension}`);
  if (!output.includes('"name":"callscript"'))
    throw new Error(`CallScript command was not registered from ${extension}`);
}

process.stdout.write("Pi RPC source and build load ok\n");
