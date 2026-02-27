# Smith Agent — Copilot Instructions

## Architecture

Smith is a **standalone remote execution agent** for the Morpheus framework. Morpheus connects to Smith over WebSocket (port 7900) and dispatches tool calls; Smith executes them locally inside a sandboxed directory.

**Core data flow:** Morpheus → WebSocket → `SmithServer` → `SmithExecutor` → DevKit tools → OS

Key modules and their roles:
- `src/server.ts` — WebSocket server; authenticates via `x-smith-auth` header, routes `task | ping | config_query` messages.
- `src/executor.ts` — Receives `{ tool, args }` payloads, looks up the matching `StructuredTool` from the DevKit registry, invokes it.
- `src/devkit/registry.ts` — Side-effect registration pattern: each tool file calls `registerToolFactory()` at import time. `buildDevKit(ctx)` assembles the final tool set filtered by config toggles.
- `src/devkit/adapters/shell.ts` — OS-aware shell adapter (Windows/Linux/Mac) using `ShellAdapter.create()` factory.
- `src/protocol/types.ts` — Wire protocol types (kept in sync with Morpheus `src/runtime/smiths/types.ts`).
- `src/config.ts` — Zod-validated config with layered resolution: YAML file (`~/.smith/config.yaml`) as base, `SMITH_*` env vars as override. Either source is sufficient on its own.
- `src/cli.ts` — Commander CLI: `init`, `start`, `stop`, `status`.

## Build & Run

```bash
npm install              # install deps
npm run build            # tsc → dist/
npm run dev              # tsx watch mode (development)
npm run start            # node bin/smith.js start (requires config.yaml or SMITH_* env vars)
npm test                 # vitest
```

Docker: `cp .env.example .env` → fill in values → `docker compose up -d`.

Entry point: `bin/smith.js` → imports `dist/index.js` → runs Commander CLI.

## Project Conventions

- **ESM-only** — `"type": "module"` in package.json. All local imports use `.js` extension (`import { foo } from './bar.js'`).
- **TypeScript strict mode** — `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`.
- **Zod v4** for runtime validation (config schema, tool input schemas via `@langchain/core/tools`).
- **LangChain `tool()` helper** — Every DevKit tool is created with `tool(handler, { name, description, schema })` from `@langchain/core/tools`, returning `StructuredTool`. Tool handlers return `JSON.stringify(...)` strings.
- **Side-effect registration** — Tool files register themselves by calling `registerToolFactory(createXTools, 'category')` at module scope. The barrel `src/devkit/index.ts` imports them in order to trigger registration.

## Adding a New DevKit Tool

1. Create `src/devkit/tools/<name>.ts`.
2. Export a factory: `function createFooTools(ctx: ToolContext): StructuredTool[]`.
3. Use `tool()` from `@langchain/core/tools` with a Zod schema for inputs.
4. Call `registerToolFactory(createFooTools, '<category>')` at the bottom.
5. Add `import './tools/<name>.js';` to `src/devkit/index.ts`.
6. If the category is toggleable, add an `enable_<name>` flag to `SmithLocalConfigSchema` in `src/config.ts` and map it in `TOGGLEABLE_CATEGORIES` in `src/devkit/registry.ts`.

## Security Model

- **Sandbox enforcement** — All file/shell/git paths are validated against `config.sandbox_dir` using `isWithinDir()` from `src/devkit/utils.ts`. Never bypass this.
- **readonly_mode** — Blocks all write/delete operations in filesystem tools via `guardPath()`.
- **Command allowlist** — `allowed_shell_commands` restricts which binaries can be executed. Empty array = allow all.
- **Auth token** — WebSocket connections must present `x-smith-auth` header matching `config.auth_token`.

## Protocol

All messages are JSON over WebSocket. Defined in `src/protocol/types.ts`:
- **Inbound** (Morpheus → Smith): `task`, `ping`, `config_query`
- **Outbound** (Smith → Morpheus): `task_result`, `task_progress`, `pong`, `register`, `config_report`
- `SMITH_PROTOCOL_VERSION = 1` — checked during handshake.

When modifying protocol types, keep them in sync with the Morpheus counterpart.

## File Structure

```
src/
  cli.ts, config.ts, executor.ts, server.ts   # Core agent
  heartbeat.ts, lifecycle.ts                    # System utils
  protocol/types.ts                             # Wire protocol
  devkit/
    index.ts          # Barrel (triggers side-effect registration)
    registry.ts       # Factory registry + buildDevKit()
    types.ts          # ToolContext, ToolResult, MAX_OUTPUT_BYTES
    utils.ts          # truncateOutput, isWithinDir, isCommandAllowed
    adapters/shell.ts # OS-aware shell execution
    tools/            # One file per tool category
specs/                # Feature specs, contracts, task breakdowns
config/               # Runtime config (config.yaml, PID, logs)
```
