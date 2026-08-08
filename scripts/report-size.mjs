import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const CORE_GZIP_LIMIT = 8 * 1024

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let failed = false
for (const file of walk('dist').sort()) {
  const buf = readFileSync(file)
  const gz = gzipSync(buf)
  const line = `${file.padEnd(28)} ${(buf.length / 1024).toFixed(2).padStart(8)} KB  gzip ${(gz.length / 1024).toFixed(2).padStart(7)} KB`
  console.log(line)
  // 体积门禁：core 入口（纯逻辑零 DOM）gzip ≤ 8KB
  if (file === 'dist/core.js' && gz.length > CORE_GZIP_LIMIT) {
    console.error(`core gzip 超限：${(gz.length / 1024).toFixed(2)} KB > 8 KB`)
    failed = true
  }
}
if (failed) process.exit(1)
