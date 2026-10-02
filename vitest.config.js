// vitest.config.js
//
// Tests live in tests/ mirroring src/, so this include is deliberately narrow: a test file
// anywhere else is not run, and a suite that is not run looks exactly like a suite that
// passes. See AGENTS.md on reading a test run by its file count and exit code.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});