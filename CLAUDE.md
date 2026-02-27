# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm run dev          # run with tsx watch (hot-reload, no build step)
npm test             # run vitest test suite
npm run start        # run the built agent (requires config.yaml or SMITH_* env vars)
```

Run a single test file:
```bash
npx vitest run src/path/to/file.test.ts
```

Docker development:
```bash
cp .env.example .env          # configure env vars
docker compose up -d           # start container
docker compose logs -f smith   # tail logs
docker compose exec smith node bin/smith.js status
```

## Architecture

Smith is a **standalone remote execution agent** for the [Morpheus](https://github.com/marcosnunesmbs/morpheus) framework. Morpheus connects over WebSocket (port 7900) and dispatches JSON tool-call messages; Smith executes them locally inside a sandboxed directory.

**Core data flow:** Morpheus → WebSocket → `SmithServer` → `SmithExecutor` → DevKit tools → OS

### Key Modules

- **`src/server.ts`** — WebSocket server; authenticates via `x-smith-auth` header; routes `task | ping | config_query` inbound messages.
- **`src/executor.ts`** — Receives `{ tool, args }` payloads, looks up the matching `StructuredTool` from the DevKit registry, invokes it.
- **`src/config.ts`** — Zod-validated config with layered resolution: YAML file (`~/.smith/config.yaml`) as base, `SMITH_*` env vars as override. Either source is sufficient.
- **`src/cli.ts`** — Commander CLI: `init`, `start`, `stop`, `status`. Entry point is `bin/smith.js → dist/index.js`.
- **`src/heartbeat.ts` / `src/lifecycle.ts`** — Periodic status pings to Morpheus; PID file management.
- **`src/protocol/types.ts`** — Wire protocol types (kept in sync with Morpheus `src/runtime/smiths/types.ts`). `SMITH_PROTOCOL_VERSION = 1`.

### DevKit (Tool System)

- **`src/devkit/registry.ts`** — Side-effect registration pattern: each tool file calls `registerToolFactory(fn, 'category')` at module scope. `buildDevKit(ctx)` assembles the final tool set filtered by config toggles (`TOGGLEABLE_CATEGORIES`).
- **`src/devkit/index.ts`** — Barrel file; imports all tool modules in order to trigger side-effect registration.
- **`src/devkit/types.ts`** — `ToolContext`, `ToolResult`, `MAX_OUTPUT_BYTES`.
- **`src/devkit/utils.ts`** — `truncateOutput`, `isWithinDir` (sandbox enforcement), `isCommandAllowed`.
- **`src/devkit/adapters/shell.ts`** — OS-aware shell adapter (Windows/Linux/Mac) via `ShellAdapter.create()` factory.
- **`src/devkit/tools/`** — One file per category: `filesystem`, `shell`, `git`, `network`, `processes`, `packages`, `system`, `browser`.

All tools are LangChain `StructuredTool` instances created with `tool(handler, { name, description, schema })` from `@langchain/core/tools`. Tool handlers return `JSON.stringify(...)` strings.

### Adding a New DevKit Tool

1. Create `src/devkit/tools/<name>.ts`.
2. Export a factory: `function createFooTools(ctx: ToolContext): StructuredTool[]`.
3. Use `tool()` from `@langchain/core/tools` with a Zod schema for inputs.
4. Call `registerToolFactory(createFooTools, '<category>')` at the bottom of the file.
5. Add `import './tools/<name>.js';` to `src/devkit/index.ts`.
6. If toggleable, add `enable_<name>` to `SmithLocalConfigSchema` in `src/config.ts` and map it in `TOGGLEABLE_CATEGORIES` in `src/devkit/registry.ts`.

## Conventions

- **ESM-only** — `"type": "module"`. All local imports must use `.js` extension (e.g., `import { foo } from './bar.js'`).
- **TypeScript strict mode** — `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`.
- **Zod v4** for all runtime validation (config schema + tool input schemas).

## Security Model

- **Sandbox enforcement** — All file/shell/git paths are validated against `config.sandbox_dir` using `isWithinDir()`. Never bypass this check.
- **readonly_mode** — Blocks write/delete operations in filesystem tools via `guardPath()`.
- **Command allowlist** — `allowed_shell_commands` restricts which binaries can be executed. Empty = allow all.
- **Auth token** — WebSocket connections must present `x-smith-auth` header matching `config.auth_token`.

## Protocol

All messages are JSON over WebSocket, defined in `src/protocol/types.ts`:
- **Inbound** (Morpheus → Smith): `task`, `ping`, `config_query`
- **Outbound** (Smith → Morpheus): `task_result`, `task_progress`, `pong`, `register`, `config_report`

When modifying protocol types, keep them in sync with the Morpheus counterpart at `src/runtime/smiths/types.ts`.
