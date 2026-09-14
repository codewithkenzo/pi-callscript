<p align="center">
  <img src="./assets/pi-callscript.webp" alt="pi-callscript" width="200" />
</p>

# pi-callscript

[![Pi package](https://img.shields.io/badge/Pi-package-6f5cff?style=flat-square)](https://pi.dev/packages/pi-callscript)
[![npm](https://img.shields.io/npm/v/pi-callscript?style=flat-square)](https://www.npmjs.com/package/pi-callscript)
[![Bun](https://img.shields.io/badge/Bun-1.4-fbf0df?style=flat-square&logo=bun&logoColor=000)](https://bun.com/)
[![Effect](https://img.shields.io/badge/Effect-v4_RC-8a2be2?style=flat-square)](https://effect.website/)

`pi-callscript` lets Pi run several tool calls as one checked script. It supports parallel work, dependencies, decision checkpoints, background jobs, and file rollback.

## Requirements

- Pi running from npm or Node.js
- Node.js 22.19 or newer

## Install

```sh
pi install npm:pi-callscript
```

Restart Pi, or reload packages in an active session:

```text
/reload
/callscript status
```

Install from GitHub or a local checkout when needed:

```sh
pi install git:github.com/codewithkenzo/pi-callscript
pi install /path/to/pi-callscript
```

## Use

CallScript starts enabled. Ask Pi to use it when work needs several related tool calls. You do not need to write CallScript code.

Example requests:

```text
Use CallScript to inspect package scripts and source imports in parallel.

Use CallScript to snapshot these files, apply the edits, then run focused checks.
```

CallScript can:

- Run independent calls in parallel.
- Pass results between dependent calls.
- Call built-in Pi tools and installed extension tools.
- Pause before queued work so Pi can continue, stop, or revise it.
- Track background jobs.
- Restore files from a snapshot.

Pi shows each operation in its normal tool view. Use `Ctrl+O` to expand details.

### Commands

| Command              | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `/callscript status` | Show mode, fixed tools, and Pi bridge status  |
| `/callscript on`     | Enable the `callscript` tool                  |
| `/callscript off`    | Disable the `callscript` tool                 |
| `/callscript jobs`   | Show background jobs                          |
| `/callscript doctor` | Show runtime and output limits                |
| `/callscript reload` | Reload config while preserving retained state |
| `/callscript reset`  | Cancel owned jobs and clear retained state    |

`off` removes only `callscript`. Other Pi tools keep their current state.

## Configuration

Global config: `~/.pi/agent/callscript.json`

Project config: `.pi/callscript.json`

Project values override global values.

```json
{
  "mode": "on",
  "limits": {
    "maxSteps": 30,
    "maxItemsPerStep": 100,
    "maxTotalCalls": 200,
    "maxConcurrency": 12,
    "maxCallResultBytes": 10485760
  },
  "httpTimeoutMs": 30000,
  "maxHttpResultBytes": 5242880
}
```

File and shell calls use the current Pi working directory. `run` uses PowerShell on Windows and Bash on Linux and macOS.

## Compatibility

Registered Pi tool access works with npm and Node.js Pi. CI tests the locked Pi version and npm `latest` on Linux, macOS, and Windows.

A standalone compiled Pi binary cannot expose its tool registry to this extension. Fixed CallScript tools still work, and `/callscript status` reports that the Pi bridge is unavailable.

## Optional agent skill

The included skill teaches Pi when to use CallScript and how to keep scripts small.

```sh
npx pi-callscript
```

Or with Bun:

```sh
bunx pi-callscript
```

This installs `SKILL.md` at `~/.agents/skills/pi-callscript/`.

## Development

```sh
git clone https://github.com/codewithkenzo/pi-callscript.git
cd pi-callscript
bun install
bun run check
bun run smoke
```

`bun run matrix` tests cold install, source, built output, packed package, user extension, and reload paths.
