import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Durable file/crypto integration suites share the disk with desktop apps.
    // Keep the default npm test run bounded; retain the existing 5s test timeout.
    maxWorkers: 2,
    // Agent worktrees hold full repo copies — without exclusions their
    // test files get collected too and every suite runs N× times.
    // This script uses Node's built-in test runner because it exercises a
    // CommonJS launcher directly. It is invoked separately by `npm test`.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.kilo/worktrees/**', 'scripts/dev-electron.test.cjs', 'scripts/dev-renderer.test.cjs', 'scripts/performance-baseline.test.cjs', 'scripts/performance-heavy-metrics.test.cjs', 'scripts/room-release-acceptance.test.cjs'],
  },
});
