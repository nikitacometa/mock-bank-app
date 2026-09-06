import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export default defineConfig({
  publicDir: false,
  build: {
    target: 'node22',
    ssr: true,
    outDir: 'bot/dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'bot/main.ts',
        repository: 'bot/repository.ts',
      },
      external: nodeBuiltins,
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
