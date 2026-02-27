/**
 * Smith heartbeat — collects system stats for pong responses.
 */
import os from 'os';
import type { SmithSystemStats } from './protocol/types.js';

/** Collect current system stats */
export function collectSystemStats(): SmithSystemStats {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Calculate CPU usage from cpus info
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }
  const cpuPercent = cpus.length > 0
    ? Math.round(((totalTick - totalIdle) / totalTick) * 100)
    : 0;

  return {
    cpu_percent: cpuPercent,
    memory_used_mb: Math.round(usedMem / (1024 * 1024)),
    memory_total_mb: Math.round(totalMem / (1024 * 1024)),
    os: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(),
    uptime_seconds: Math.round(os.uptime()),
  };
}
