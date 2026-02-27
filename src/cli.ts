/**
 * Smith CLI — Commander-based CLI for the Smith binary.
 * Commands: start, stop, status, init
 */
import { Command } from 'commander';
import fs from 'fs-extra';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import {
  loadConfig,
  getConfig,
  SMITH_PATHS,
  generateDefaultConfig,
} from './config.js';
import { scaffold, writePid, removePid, readPid } from './lifecycle.js';
import { SmithExecutor } from './executor.js';
import { SmithServer } from './server.js';
import { collectSystemStats } from './heartbeat.js';

const program = new Command();

program
  .name('smith')
  .description('Smith — Remote agent for Morpheus')
  .version('0.1.0');

// ─── init ───

program
  .command('init')
  .description('Initialize Smith config directory and generate default config')
  .option('-n, --name <name>', 'Smith instance name', 'smith-' + randomUUID().slice(0, 8))
  .action(async (opts) => {
    scaffold();

    if (fs.existsSync(SMITH_PATHS.config)) {
      console.log(chalk.yellow(`Config already exists at ${SMITH_PATHS.config}`));
      console.log('Delete it first if you want to reinitialize.');
      return;
    }

    const authToken = randomUUID();
    const content = generateDefaultConfig(opts.name, authToken);
    fs.writeFileSync(SMITH_PATHS.config, content, 'utf-8');

    console.log(chalk.green(`✓ Smith initialized at ${SMITH_PATHS.home}`));
    console.log(chalk.dim(`  Config: ${SMITH_PATHS.config}`));
    console.log(chalk.dim(`  Name:   ${opts.name}`));
    console.log(chalk.dim(`  Token:  ${authToken}`));
    console.log('');
    console.log(chalk.cyan('Add this entry to your Morpheus zaion.yaml:'));
    console.log('');
    console.log(`  smiths:`);
    console.log(`    enabled: true`);
    console.log(`    entries:`);
    console.log(`      - name: ${opts.name}`);
    console.log(`        host: <this-machine-ip>`);
    console.log(`        port: 7900`);
    console.log(`        auth_token: "${authToken}"`);
  });

// ─── start ───

program
  .command('start')
  .description('Start the Smith agent')
  .action(async () => {
    scaffold();

    let config;
    try {
      config = loadConfig();
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    if (!writePid()) {
      console.error(chalk.red('Another Smith instance is already running.'));
      process.exit(1);
    }

    console.log(chalk.green(`Starting Smith '${config.name}' on port ${config.port}...`));
    console.log(chalk.dim(`  Auth token: ${config.auth_token}`));

    const executor = new SmithExecutor(config);
    await executor.initialize();
    console.log(chalk.dim(`  Tools loaded: ${executor.getCapabilities().length} (${executor.getCapabilities().join(', ')})`));

    const server = new SmithServer({
      config,
      executor,
      onLog: (msg, level) => {
        const color = level === 'error' ? chalk.red
          : level === 'warn' ? chalk.yellow
          : level === 'info' ? chalk.green
          : chalk.dim;
        console.log(`${chalk.dim(new Date().toISOString())} ${color(`[${level.toUpperCase()}]`)} ${msg}`);
      },
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log(chalk.yellow('\nShutting down Smith...'));
      await server.stop();
      removePid();
      console.log(chalk.green('Smith stopped.'));
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await server.start();
      console.log(chalk.green(`✓ Smith '${config.name}' is running`));
      console.log(chalk.dim(`  Sandbox: ${config.sandbox_dir}`));
      console.log(chalk.dim(`  Readonly: ${config.readonly_mode}`));
    } catch (err: any) {
      console.error(chalk.red(`Failed to start: ${err.message}`));
      removePid();
      process.exit(1);
    }
  });

// ─── stop ───

program
  .command('stop')
  .description('Stop a running Smith instance')
  .action(() => {
    const pid = readPid();
    if (!pid) {
      console.log(chalk.yellow('No Smith instance is running.'));
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(chalk.green(`Sent SIGTERM to Smith (PID: ${pid}).`));
    } catch (err: any) {
      console.error(chalk.red(`Failed to stop: ${err.message}`));
      removePid(); // cleanup stale PID
    }
  });

// ─── status ───

program
  .command('status')
  .description('Show Smith instance status')
  .action(() => {
    const pid = readPid();
    if (!pid) {
      console.log(chalk.yellow('Smith is not running.'));
      return;
    }

    console.log(chalk.green(`Smith is running (PID: ${pid})`));

    try {
      const config = loadConfig();
      console.log(chalk.dim(`  Name: ${config.name}`));
      console.log(chalk.dim(`  Port: ${config.port}`));
      console.log(chalk.dim(`  Sandbox: ${config.sandbox_dir}`));

      const stats = collectSystemStats();
      console.log(chalk.dim(`  CPU: ${stats.cpu_percent}%`));
      console.log(chalk.dim(`  Memory: ${stats.memory_used_mb}/${stats.memory_total_mb} MB`));
      console.log(chalk.dim(`  OS: ${stats.os}`));
      console.log(chalk.dim(`  Uptime: ${Math.round(stats.uptime_seconds / 3600)}h`));
    } catch {
      // config not available, just show PID
    }
  });

export { program };
