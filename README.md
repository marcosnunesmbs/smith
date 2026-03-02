# SMITH Agent

The SMITH agent is a lightweight extension of the Morpheus framework designed to operate on remote machines. It allows for executing commands and managing tasks outside the user's local environment, effectively acting as a "clone" of the Morpheus agent.

## Features

- **Remote Command Execution**: Execute commands on remote machines seamlessly.
- **Agent Registration**: Register the SMITH agent with the Morpheus daemon for management and monitoring.
- **Heartbeat Mechanism**: Maintain connectivity with the Morpheus daemon through periodic status updates.
- **Sandbox Environment**: Execute commands in a secure sandbox to prevent unauthorized access to the host system.
- **Transport Layer**: Utilize secure communication protocols for data exchange between the SMITH agent and the Morpheus daemon.

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/marcosnunesmbs/smith
   cd smith
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Configure environment variables:
   Copy the `.env.example` to `.env` and update the necessary configurations.

## Usage

### Local

```bash
npx . init --name my-smith   # generates config.yaml + auth token
npx . start                  # starts the agent
npx . status                 # check status
npx . stop                   # stop the agent
```

### Global (npm)

1. Install globally:
   ```bash
   npm install -g morpheus-smith
   ```

2. Initialize and start:
   ```bash
   smith init --name my-smith   # generates config.yaml + auth token
   smith start                  # starts the agent
   smith status                 # check status
   smith stop                   # stop the agent
   ```

### Docker

1. Copy `.env.example` to `.env` and adjust as needed:
   ```bash
   cp .env.example .env
   ```

2. Start the container:
   ```bash
   docker compose up -d
   ```

3. Check status:
   ```bash
   docker compose exec smith node bin/smith.js status
   ```

4. View logs:
   ```bash
   docker compose logs -f smith
   ```

> **Note:** `auth_token` is auto-generated if not provided. To persist a token, either set `SMITH_AUTH_TOKEN` in `.env` or run `smith init` before starting.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SMITH_NAME` | `smith` | Instance name |
| `SMITH_PORT` | `7900` | WebSocket port |
| `SMITH_AUTH_TOKEN` | *(auto-generated)* | Auth token for Morpheus connection |
| `SMITH_SANDBOX_DIR` | `/workspace` | Sandbox root directory |
| `SMITH_READONLY_MODE` | `false` | Block write/delete operations |
| `SMITH_ENABLE_FILESYSTEM` | `true` | Enable filesystem tools |
| `SMITH_ENABLE_SHELL` | `true` | Enable shell tools |
| `SMITH_ENABLE_GIT` | `true` | Enable git tools |
| `SMITH_ENABLE_NETWORK` | `true` | Enable network tools |
| `SMITH_ALLOWED_SHELL_COMMANDS` | *(empty = all)* | Comma-separated command allowlist |
| `SMITH_TIMEOUT_MS` | `30000` | Tool execution timeout (ms) |
| `SMITH_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

## Development

For contributions and feature requests, please refer to the `specs` directory for detailed specifications and implementation plans.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.