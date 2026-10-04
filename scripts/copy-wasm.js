/**
 * Copies sql-wasm.wasm to public/ so Vite (and the built dist/) serve it
 * as a real binary. Without this Vite returns index.html (the SPA fallback)
 * which gives WebAssembly "expected magic word 00 61 73 6d, found 3c 21 44 4f".
 */
const fs   = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
const dst = path.resolve(__dirname, '../public/sql-wasm.wasm');

if (!fs.existsSync(src)) {
  console.warn('[copy-wasm] sql-wasm.wasm not found yet — run npm install first');
  process.exit(0);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('[copy-wasm] Copied sql-wasm.wasm → public/sql-wasm.wasm');
