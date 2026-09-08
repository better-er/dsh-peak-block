import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-peak-block/lib',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
