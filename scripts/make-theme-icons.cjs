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
/** 把颜色朝白(255)或黑(0)混合；t=0 保持原色 */
function mixToward(r,g,b,target,t){return [Math.round(r+(target-r)*t),Math.round(g+(target-g)*t),Math.round(b+(target-b)*t)]}

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
    /*
     * 应用图标（窗口内标题栏用的就是这张）。
     *
     * v1.4.13-pre9 修正（用户第 1 项「窗口内标题栏和托盘的图标发暗」）：
     * 原实现是 a = 主题色 × (0.55 + 0.45×亮度)，也就是把整张图压到 55%~100% 亮度。
     * 浅粉底（亮度 0.6）只剩 82%，近白字形也只剩 96%——两档一起被压暗，
     * 于是标题栏里就是一枚灰蒙蒙的图。
     *
     * 现在与托盘同一套算法：保留原图的亮度关系，只替换色相。
     * 底色走主题色的浅→深渐变（浅档向白提亮，而不是压暗），
     * 字形保留近白，因此标题栏里的观感与桌面图标一致。
     */
    const a=Buffer.from(app.data);
    const S2=app.w;
    const radius2=S2*0.225;
    const [ilr,ilg,ilb]=mixToward(tr,tg,tb,255,0.42);
    const [idr,idg,idb]=mixToward(tr,tg,tb,0,0.16);
    for(let y=0;y<S2;y++){
      const gy=y/(S2-1);
      const br=ilr+(idr-ilr)*gy, bg2=ilg+(idg-ilg)*gy, bb=ilb+(idb-ilb)*gy;
      for(let x=0;x<S2;x++){
        const i=(y*S2+x)*4;
        let inside=1;
        const cx=x<radius2?radius2:(x>S2-radius2?S2-radius2:x);
        const cy=y<radius2?radius2:(y>S2-radius2?S2-radius2:y);
        if(cx!==x||cy!==y){
          const dx=x-cx,dy=y-cy;
          inside=Math.sqrt(dx*dx+dy*dy)<=radius2?1:0;
        }
        if(!inside){ a[i]=0;a[i+1]=0;a[i+2]=0;a[i+3]=0; continue }
        const lum=(0.299*a[i]+0.587*a[i+1]+0.114*a[i+2])/255;
        const m=Math.max(0,Math.min(1,(lum-0.55)/0.45));
        const eased=m*m*(3-2*m);
        a[i]=Math.round(br*(1-eased)+252*eased);
        a[i+1]=Math.round(bg2*(1-eased)+236*eased);
        a[i+2]=Math.round(bb*(1-eased)+242*eased);
        a[i+3]=255;
      }
    }
    fs.writeFileSync(path.join(outDir,'icon-'+id+'-'+mode+'.png'),encodePng(app.w,app.h,a));
    /*
     * 托盘图标：直接取桌面图标那套光影，只把色相换成本主题。
     *
     * v1.4.13-pre7 修正（用户反馈「白色太暗、主题色太深、没有光影」）：
     * pre6 是把白色字形压成纯白、其余压成单一主题色的「双色平涂」，
     * 于是既没有 icon.ico 那种由浅到深的渐变底，也没有字形的立体感。
     * 现在改为对桌面图标逐像素做「保留亮度、替换色相」：
     * - 底色沿用原图的渐变（浅粉→深粉），按主题色的亮暗两档线性映射；
     * - 字形保留原图接近白的亮度，因此仍是明亮的白字带阴影。
     * 这样托盘图标与 icon.ico 是同一套设计，只换主色。
     */
    const t=Buffer.from(app.data);
    const S=app.w;
    const radius=S*0.225;
    // 主题色的亮档与暗档：亮档用于背景上部，暗档用于背景下部，形成渐变
    const [lr,lg,lb]=mixToward(tr,tg,tb,255,0.42);
    const [dr,dg,db]=mixToward(tr,tg,tb,0,0.16);
    for(let y=0;y<S;y++){
      const gy=y/(S-1); // 0 = 顶，1 = 底
      const br=lr+(dr-lr)*gy, bg2=lg+(dg-lg)*gy, bb=lb+(db-lb)*gy;
      for(let x=0;x<S;x++){
        const i=(y*S+x)*4;
        // 圆角矩形：四角按圆裁掉
        let inside=1;
        const cx=x<radius?radius:(x>S-radius?S-radius:x);
        const cy=y<radius?radius:(y>S-radius?S-radius:y);
        if(cx!==x||cy!==y){
          const dx=x-cx,dy=y-cy;
          inside=Math.sqrt(dx*dx+dy*dy)<=radius?1:0;
        }
        if(!inside){ t[i]=0;t[i+1]=0;t[i+2]=0;t[i+3]=0; continue }
        /*
         * 用原图亮度当权重：原图字形接近白（lum≈0.90），背景是粉（lum≈0.60）。
         * 把 [0.55, 1.0] 映射到 [0, 1]，得到「字形=1、背景=0」的掩膜，
         * 再按掩膜在「主题色渐变底」与「近白字形」之间插值——
         * 字形因此保留原图的柔和边缘与阴影过渡，而不是硬切的纯白。
         */
        const lum=(0.299*t[i]+0.587*t[i+1]+0.114*t[i+2])/255;
        const m=Math.max(0,Math.min(1,(lum-0.55)/0.45));
        const eased=m*m*(3-2*m); // smoothstep：让字形边缘过渡自然
        const gr=252, gg=236, gb=242; // 参考图标的近白字形
        t[i]=Math.round(br*(1-eased)+gr*eased);
        t[i+1]=Math.round(bg2*(1-eased)+gg*eased);
        t[i+2]=Math.round(bb*(1-eased)+gb*eased);
        t[i+3]=255;
      }
    }
    fs.writeFileSync(path.join(outDir,'tray-'+id+'-'+mode+'.png'),encodePng(S,S,t));
    n+=2;
  }
}
console.log('generated',n,'files (icon + tray per theme/mode)');