import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees hold full repo copies — without exclusions their
    // test files get collected too and every suite runs N× times.
    // This script uses Node's built-in test runner because it exercises a
    // CommonJS launcher directly. It is invoked separately by `npm test`.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.kilo/worktrees/**', 'scripts/dev-electron.test.cjs', 'scripts/dev-renderer.test.cjs'],
  },
});
