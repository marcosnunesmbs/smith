#!/usr/bin/env node

// Suppress experimental warnings (JSON module imports)
const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (
    name === 'warning' &&
    typeof data === 'object' &&
    data.name === 'ExperimentalWarning' &&
    data.message.includes('Importing JSON modules')
  ) {
    return false;
  }
  return originalEmit.apply(process, [name, data, ...args]);
};

await import('../dist/index.js');
