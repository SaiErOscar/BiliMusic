// v1.4.13-pre3 主题化图标生成器
// 以现有 icon.png 为形状母版，按各主题主色重着色，生成同设计不同配色的图标集。
// 输出到 electron/icons/ 下，命名 icon-<themeId>-<mode>.png 与 tray-<themeId>-<mode>.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 内置主题主色（与 src/theme/tokens.ts 保持一致）
const THEMES = {
  default:  { light: '#FB7299', dark: '#FB7299' },
  ocean:    { light: '#1B84D6', dark: '#3FA9F5' },
  forest:   { light: '#2F9E5E', dark: '#4FBF7F' },
  twilight: { light: '#7C5CFC', dark: '#9B84FF' },
  graphite: { light: '#5A5F6A', dark: '#8A909C' },
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// 极简 PNG 解码/编码：只支持 8 位 RGBA（icon.png 是这种）
function decodePng(buf) {
  let pos = 8; let w=0,h=0; const idat=[];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos+4, pos+8);
    const data = buf.subarray(pos+8, pos+8+len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y-1)*stride, y*stride) : Buffer.alloc(stride);
    const cur = out.subarray(y*stride, (y+1)*stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x-bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x-bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a+b)/2);
      else if (filter === 4) {
        const p = a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
        v += (pa<=pb && pa<=pc) ? a : (pb<=pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, data: out };
}

function encodePng(w, h, rgba) {
  const stride = w*4;
  const raw = Buffer.alloc(h*(stride+1));
  for (let y=0;y<h;y++){ raw[y*(stride+1)]=0; rgba.copy(raw, y*(stride+1)+1, y*stride, (y+1)*stride); }
  const idat = zlib.deflateSync(raw);
  const chunks = [];
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  function chunk(type, data){
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type,'ascii');
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

let CRC_TABLE = null;
function crc32(buf){
  if(!CRC_TABLE){
    CRC_TABLE = new Int32Array(256);
    for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; CRC_TABLE[n]=c; }
  }
  let c = 0xFFFFFFFF;
  for(let i=0;i<buf.length;i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c>>>8);
  return c ^ 0xFFFFFFFF;
}

const src = decodePng(fs.readFileSync('electron/icon.png'));
console.log('source', src.w+'x'+src.h);
const outDir = 'electron/icons';
fs.mkdirSync(outDir, { recursive: true });

let count = 0;
for (const [id, modes] of Object.entries(THEMES)) {
  for (const [mode, hex] of Object.entries(modes)) {
    const [tr,tg,tb] = hexToRgb(hex);
    const out = Buffer.from(src.data);
    for (let i=0;i<out.length;i+=4){
      const a = out[i+3];
      if (!a) continue;
      // 保留原图的明暗层次：按原像素亮度映射到目标色
      const lum = (0.299*out[i] + 0.587*out[i+1] + 0.114*out[i+2]) / 255;
      const k = 0.55 + 0.45*lum;
      out[i]   = Math.min(255, Math.round(tr*k));
      out[i+1] = Math.min(255, Math.round(tg*k));
      out[i+2] = Math.min(255, Math.round(tb*k));
    }
    fs.writeFileSync(path.join(outDir, 'icon-'+id+'-'+mode+'.png'), encodePng(src.w, src.h, out));
    count++;
  }
}
console.log('generated', count, 'icons in', outDir);