// v1.4.11-pre3 构建辅助：绕过 electron-builder 图标工具的 WASM 内存失败
// 本机 icon-tool.js 处理 1024x1024 PNG 时申请线性内存失败（Error: WebAssembly.Memory(): could not allocate memory）。
// 改用 PNG-in-ICO（Vista+ 支持）直接打包源图，多尺寸条目共用同一 PNG，Windows 自行降采样。
const fs = require('fs');
const png = fs.readFileSync('electron/icon.png');
const sizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + sizes.length * 16;
for (const s of sizes) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
}
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.ico', Buffer.concat([header, ...entries, ...sizes.map(() => png)]));
console.log('build/icon.ico', fs.statSync('build/icon.ico').size, 'bytes');