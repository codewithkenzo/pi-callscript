# Pi 1.0 bridge compatibility and update tracking

## Context

Pi CLI 1.0.2 cannot load CallScript: extension startup fails resolving runtime peer import `@earendil-works/pi-coding-agent` in `src/pi-tool-bridge.ts`. The published package does declare a root export, so root-export absence is not proven; extension-host module resolution is the failure. User disabled active registration; cached Git clone remains. Restore compatibility through supported Pi APIs, strengthen version-update CI, publish fix.

## Approach

Use Pi 1.0's documented `ExtensionToolContext.executeTool()` for nested calls and `ExtensionAPI.getAllTools()` for discovery; both avoid private `AgentSession` prototype patching and preserve Pi policy hooks. Keep existing bridge as an isolated optional fallback for Pi 0.84.4 if tests confirm it remains viable. Remove mandatory runtime import so extension registers when Pi package root cannot resolve. Refresh all dependencies including majors, migrate breakages, then publish. Track future updates with weekly Dependabot Bun updates plus scheduled/manual latest-Pi compatibility CI. Research: [Pi 1.0.2 package exports](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.2/package.json), [Pi extensions API](https://pi.dev/docs/latest/extensions), [Pi changelog](https://pi.dev/changelog), [Dependabot supported ecosystems](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories).

## Files to modify

- `src/pi-tool-bridge.ts` — use native 1.0 bridge; keep old-version fallback optional, never mandatory at module load.
- `.github/workflows/ci.yml` — PR + weekly/manual locked/legacy/latest compatibility coverage.
- `.github/dependabot.yml` — weekly Bun ecosystem updates for all dependencies.
- `package.json` and `bun.lock` — refresh all versions/lock graph and bump release version.
- `README.md` — document verified Pi compatibility and CI coverage.
- `tests/pi-tool-bridge.test.ts`, `tests/pi-smoke.ts`, `tests/local-install-reload.ts` — bridge regression, real-host, release-version checks.

## Reuse

- Existing bridge capture, policy forwarding, and status behavior in `src/pi-tool-bridge.ts`.
- Existing Pi compatibility workflow in `.github/workflows/ci.yml`.
- Existing smoke suite: `tests/pi-smoke.ts` (`bun run smoke`).

## Steps

- [x] Research Pi CLI 1.0.2 supported exports/API and identify stable bridge seam.
- [x] Inspect Pi 0.84.4 API and bridge tests; it lacks `executeTool`, so retain old-host behavior where feasible.
- [x] Replace mandatory runtime import/prototype assumptions; test when peer package root is unresolvable and against Pi 1.0 API.
- [x] Update every dependency to latest, including majors; migrate failures and regenerate `bun.lock`.
- [x] Improve CI with PR locked/legacy/latest checks, weekly + manual latest-Pi run, resolved-version reporting; configure weekly Dependabot updates for all Bun dependencies.
- [ ] Update compatibility/release metadata; run focused/full checks and Pi 1.0.2 install/load/command/tool smoke; publish release.

## Verification

- Regression test simulates unavailable peer package resolution without preventing CallScript registration.
- Pi 1.0.2 extension load and `/callscript status`/bridged tool smoke succeed; retain legacy smoke if fallback is kept.
- CI passes for lockfile Pi, explicit legacy Pi (if supported), and latest Pi; weekly/manual jobs report resolved Pi version.
- Dependabot Bun updates cover all dependencies and open CI-tested PRs.
- All dependencies including majors are refreshed; complete test, lint, typecheck, build, smoke, pack, and publish checks pass.

## Decisions

- Update all dependencies, including major versions; perform migrations where needed.
- Include publishing; weekly current-Pi CI cadence confirmed.

## Findings

- Initial lock pinned Pi packages at `0.84.4`; refreshed lock pins `1.0.4`. Pi `1.0.2` public types expose nested tool execution, and npm manifest includes `.` export, so runtime module resolution—not package export-map absence—is likely failure.
- Weekly Bun Dependabot and scheduled/manual compatibility CI are configured. No automated npm publish workflow exists. Release convention bumps `package.json` and `tests/local-install-reload.ts` together; release version: `0.3.2`.
- No repository benchmark harness found; benchmark remains post-publish follow-up alongside user's installed-Git smoke test.
