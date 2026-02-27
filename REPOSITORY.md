# Smith Agent

A standalone remote execution agent for the [Morpheus](https://github.com/marcosnunesmbs/morpheus) framework. Smith connects to Morpheus over WebSocket and executes tool calls locally inside a sandboxed directory.

## Quick Start

```bash
docker run -d \
  --name smith \
  -p 7900:7900 \
  -e SMITH_NAME=smith \
  -v smith-data:/root/.smith \
  -v ./workspace:/workspace \
  marcosnunesmbs/smith:latest
```

Check the logs to see the auto-generated auth token:

```bash
docker logs smith
```

```
Starting Smith 'smith' on port 7900...
  Auth token: 519354a4-afba-4b61-bcd5-547fbe59212f
```

Use this token in your Morpheus `zaion.yaml`:

```yaml
smiths:
  enabled: true
  entries:
    - name: smith
      host: <smith-machine-ip>
      port: 7900
      auth_token: "519354a4-afba-4b61-bcd5-547fbe59212f"
```

## Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  smith:
    image: marcosnunesmbs/smith:latest
    container_name: smith
    restart: unless-stopped
    ports:
      - "7900:7900"
    volumes:
      - smith-data:/root/.smith
      - ./workspace:/workspace
    environment:
      - SMITH_NAME=smith
      - SMITH_PORT=7900
      - SMITH_SANDBOX_DIR=/workspace

volumes:
  smith-data:
```

```bash
docker compose up -d
```

### Multiple Instances

```yaml
services:
  smith1:
    image: marcosnunesmbs/smith:latest
    container_name: smith-1
    ports:
      - "7900:7900"
    volumes:
      - smith-data-1:/root/.smith
      - ./workspace:/workspace
    environment:
      - SMITH_NAME=smith1
      - SMITH_PORT=7900

  smith2:
    image: marcosnunesmbs/smith:latest
    container_name: smith-2
    ports:
      - "7901:7901"
    volumes:
      - smith-data-2:/root/.smith
      - ./workspace:/workspace
    environment:
      - SMITH_NAME=smith2
      - SMITH_PORT=7901

volumes:
  smith-data-1:
  smith-data-2:
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SMITH_NAME` | *(required)* | Instance name (lowercase, alphanumeric, hyphens) |
| `SMITH_PORT` | `7900` | WebSocket server port |
| `SMITH_AUTH_TOKEN` | *(auto-generated)* | Auth token for Morpheus connection. Auto-generated and persisted to `/root/.smith/auth_token` if omitted |
| `SMITH_SANDBOX_DIR` | `/workspace` | Root directory for all tool operations |
| `SMITH_READONLY_MODE` | `false` | Block write/delete operations |
| `SMITH_ENABLE_FILESYSTEM` | `true` | Enable filesystem tools |
| `SMITH_ENABLE_SHELL` | `true` | Enable shell tools |
| `SMITH_ENABLE_GIT` | `true` | Enable git tools |
| `SMITH_ENABLE_NETWORK` | `true` | Enable network tools |
| `SMITH_ALLOWED_SHELL_COMMANDS` | *(empty = all)* | Comma-separated allowlist (e.g. `git,node,npm`) |
| `SMITH_TIMEOUT_MS` | `30000` | Tool execution timeout in milliseconds |
| `SMITH_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## Auth Token

The auth token is resolved in order:

1. `SMITH_AUTH_TOKEN` env var (if set)
2. Persisted token at `/root/.smith/auth_token` (survives restarts via volume)
3. Auto-generated UUID (saved to `/root/.smith/auth_token`)

The token is always printed in the startup logs.

## Volumes

| Path | Purpose |
|---|---|
| `/root/.smith` | Persists auth token, logs, and browser cache. **Mount a named volume here.** |
| `/workspace` | Sandbox directory where Smith operates. Mount your project files here. |

## Tools (50 built-in)

Smith ships with tools across these categories:

- **Filesystem** — `read_file`, `write_file`, `list_dir`, `search_in_files`, `find_files`, etc.
- **Shell** — `run_command`, `run_script`, `which`
- **Git** — `git_status`, `git_diff`, `git_commit`, `git_push`, `git_clone`, etc.
- **Network** — `http_request`, `ping`, `port_check`, `dns_lookup`, `download_file`
- **Processes** — `list_processes`, `get_process`, `kill_process`
- **Packages** — `npm_install`, `npm_run`, `pip_install`, `cargo_build`
- **System** — `system_info`, `env_read`, `notify`, `clipboard`
- **Browser** — `browser_navigate`, `browser_get_dom`, `browser_click`, `browser_fill`, `browser_search`

## Tags

- `latest` — Latest stable release
- `0.1.0` — Initial release
