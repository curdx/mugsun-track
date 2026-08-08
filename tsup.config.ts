import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'vue/index': 'src/vue/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  minify: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: 'es2018',
  external: ['vue']
})
