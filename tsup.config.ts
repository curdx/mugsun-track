import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'vue/index': 'src/vue/index.ts',
    'replay/index': 'src/plugins/replay/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  minify: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: 'es2018',
  // rrweb 保持外部依赖：replay 入口内 dynamic import 原样保留，宿主按需加载
  external: ['vue', 'rrweb']
})
