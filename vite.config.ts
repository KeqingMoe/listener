import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const src = (name: string) => `${root}packages/${name}/src`;

function packageAtAlias(): Plugin {
  return {
    name: 'package-at-alias',
    resolveId(id, importer) {
      if (id !== '@' && !id.startsWith('@/')) {
        return;
      }
      if (!importer) {
        return;
      }
      const match = importer.match(/[\\/]packages[\\/]([^\\/]+)[\\/]/);
      if (!match) {
        return;
      }
      const rest = id === '@' ? '/index' : id.slice(1);
      const path = `${src(match[1]!)}${rest}`;
      return path.endsWith('.ts') ? path : `${path}.ts`;
    },
  };
}

export default defineConfig({
  plugins: [packageAtAlias()],
  build: {
    ssr: true,
    sourcemap: true,
    minify: false,
    target: 'node24',
    emptyOutDir: false,
    rolldownOptions: {
      input: {},
      preserveEntrySignatures: 'strict',
      output: {
        format: 'esm',
        dir: root,
        entryFileNames: chunk => `packages/${chunk.name}/dist/index.js`,
      },
      external: [/^node:/, /^(?:@(?!\/)|[a-zA-Z])/],
    },
  },
  test: {
    passWithNoTests: true,
    include: ['packages/*/tests/**/*.test.ts'],
    alias: {},
  },
});
