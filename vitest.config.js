import { defineConfig } from 'vitest/config';

// Engine modules are pure ESM with no DOM, so the default node environment
// is correct and fast. UI/component tests (if added later) should opt into
// jsdom per-file with the `// @vitest-environment jsdom` pragma.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
