await import("@earendil-works/pi-coding-agent");
await import("@earendil-works/pi-tui");
Bun.gc(true);
const before = process.memoryUsage();

await import("../dist/index.mjs");
Bun.gc(true);
const after = process.memoryUsage();

const mebibytes = (bytes: number) => Number((bytes / 1_048_576).toFixed(2));

process.stdout.write(
  `${JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      heapDeltaMiB: mebibytes(after.heapUsed - before.heapUsed),
      rssDeltaMiB: mebibytes(after.rss - before.rss),
    },
    undefined,
    2,
  )}\n`,
);
