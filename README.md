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
   git clone <repository-url>
   cd smith
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Configure environment variables:
   Copy the `.env.example` to `.env` and update the necessary configurations.

## Usage

To start the SMITH agent, run:
```
npm run start
```

You can also use the command-line interface to manage the agent:
- Start the agent: `npm run start`
- Stop the agent: `npm run stop`
- Check status: `npm run status`
- Register the agent: `npm run register`

## Development

For contributions and feature requests, please refer to the `specs` directory for detailed specifications and implementation plans.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.