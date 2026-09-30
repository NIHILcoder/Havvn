import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // .claude holds session worktrees (full repo copies) — without this their
    // test files get collected too and every suite runs N× times.
    // This script uses Node's built-in test runner because it exercises a
    // CommonJS launcher directly. It is invoked separately by `npm test`.
    exclude: [...configDefaults.exclude, '**/.claude/**', 'scripts/dev-electron.test.cjs'],
  },
});
