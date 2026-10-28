const fs=require('fs');
const path=require('path');
const zlib=require('zlib');

const THEMES={
  default:{light:'#FB7299',dark:'#FB7299'},
  ocean:{light:'#1B84D6',dark:'#3FA9F5'},
  forest:{light:'#2F9E5E',dark:'#4FBF7F'},
  twilight:{light:'#7C5CFC',dark:'#9B84FF'},
  graphite:{light:'#5A5F6A',dark:'#8A909C'},
};
function hexToRgb(h){h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]}

function decodePng(buf){
  let pos=8,w=0,h=0,ct=0,bd=0;const idat=[];
  while(pos<buf.length){
    const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);
    const data=buf.subarray(pos+8,pos+8+len);
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);bd=data[8];ct=data[9]}
    else if(type==='IDAT')idat.push(data);
    pos+=12+len;
  }
  if(bd!==8||ct!==6) throw new Error('unsupported png: bd='+bd+' ct='+ct);
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp=4,stride=w*bpp;const out=Buffer.alloc(h*stride);let rp=0;
  for(let y=0;y<h;y++){
    const f=raw[rp++];const line=raw.subarray(rp,rp+stride);rp+=stride;
    const prev=y>0?out.subarray((y-1)*stride,y*stride):Buffer.alloc(stride);
    const cur=out.subarray(y*stride,(y+1)*stride);
    for(let x=0;x<stride;x++){
      const a=x>=bpp?cur[x-bpp]:0,b=prev[x],c=x>=bpp?prev[x-bpp]:0;let v=line[x];
      if(f===1)v+=a;else if(f===2)v+=b;else if(f===3)v+=Math.floor((a+b)/2);
      else if(f===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c)}
      cur[x]=v&0xff;
    }
  }
  return {w,h,data:out};
}
let T=null;
function crc32(buf){if(!T){T=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c}}let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++)c=T[(c^buf[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function encodePng(w,h,rgba){
  const stride=w*4;const raw=Buffer.alloc(h*(stride+1));
  for(let y=0;y<h;y++){raw[y*(stride+1)]=0;rgba.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride)}
  const idat=zlib.deflateSync(raw);
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc])}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
}

// 应用图标：保留明暗层次（按原亮度调制）
const app=decodePng(fs.readFileSync('electron/icon.png'));
// 托盘图标：原图是纯白单色（靠系统反色适配深浅任务栏），只能换色相不能套亮度映射
const tray=decodePng(fs.readFileSync('electron/tray.png'));
const outDir='electron/icons';fs.mkdirSync(outDir,{recursive:true});
let n=0;
for(const [id,modes] of Object.entries(THEMES)){
  for(const [mode,hex] of Object.entries(modes)){
    const [tr,tg,tb]=hexToRgb(hex);
    // 应用图标
    const a=Buffer.from(app.data);
    for(let i=0;i<a.length;i+=4){
      const al=a[i+3];if(!al)continue;
      const lum=(0.299*a[i]+0.587*a[i+1]+0.114*a[i+2])/255;
      const k=0.55+0.45*lum;
      a[i]=Math.min(255,Math.round(tr*k));a[i+1]=Math.min(255,Math.round(tg*k));a[i+2]=Math.min(255,Math.round(tb*k));
    }
    fs.writeFileSync(path.join(outDir,'icon-'+id+'-'+mode+'.png'),encodePng(app.w,app.h,a));
    /*
     * 托盘图标：按桌面图标的结构做——主题色圆角衬底 + 纯白字形。
     *
     * v1.4.13-pre6 修正：原来只把白色字形整体染成主题色、底子透明，
     * 于是托盘里是一枚纯色剪影，和桌面图标的「圆角底 + 字形」不是一回事。
     * 现在按 tray.png 的 alpha 分两层：有字形处画白，其余画主题色的圆角方块。
     * 圆角半径取边长的 22.5%（与 256px 桌面图标观感一致）。
     */
    const t=Buffer.from(tray.data);
    const S=tray.w;
    const radius=S*0.225;
    for(let y=0;y<tray.h;y++){
      for(let x=0;x<S;x++){
        const i=(y*S+x)*4;
        // 圆角矩形的覆盖判定：四角按圆裁掉
        let inside=1;
        const cx=x<radius?radius:(x>S-radius?S-radius:x);
        const cy=y<radius?radius:(y>S-radius?S-radius:y);
        if(cx!==x||cy!==y){
          const dx=x-cx,dy=y-cy;
          const d=Math.sqrt(dx*dx+dy*dy);
          inside=d<=radius?1:0;
        }
        if(!inside){ t[i]=0;t[i+1]=0;t[i+2]=0;t[i+3]=0; continue }
        const glyph=t[i+3]/255;
        // 字形处纯白，其余为主题色衬底
        t[i]=Math.round(255*glyph+tr*(1-glyph));
        t[i+1]=Math.round(255*glyph+tg*(1-glyph));
        t[i+2]=Math.round(255*glyph+tb*(1-glyph));
        t[i+3]=255;
      }
    }
    fs.writeFileSync(path.join(outDir,'tray-'+id+'-'+mode+'.png'),encodePng(tray.w,tray.h,t));
    n+=2;
  }
}
console.log('generated',n,'files (icon + tray per theme/mode)');