const fs=require('fs');const path=require('path');const zlib=require('zlib');
function decodePng(buf){
  let pos=8,w=0,h=0,ct=0,bd=0;const idat=[];
  while(pos<buf.length){const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);const data=buf.subarray(pos+8,pos+8+len);
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);bd=data[8];ct=data[9]}else if(type==='IDAT')idat.push(data);pos+=12+len}
  const raw=zlib.inflateSync(Buffer.concat(idat));const bpp=4,stride=w*bpp;const out=Buffer.alloc(h*stride);let rp=0;
  for(let y=0;y<h;y++){const f=raw[rp++];const line=raw.subarray(rp,rp+stride);rp+=stride;
    const prev=y>0?out.subarray((y-1)*stride,y*stride):Buffer.alloc(stride);const cur=out.subarray(y*stride,(y+1)*stride);
    for(let x=0;x<stride;x++){const a=x>=bpp?cur[x-bpp]:0,b=prev[x],c=x>=bpp?prev[x-bpp]:0;let v=line[x];
      if(f===1)v+=a;else if(f===2)v+=b;else if(f===3)v+=Math.floor((a+b)/2);
      else if(f===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c)}cur[x]=v&0xff}}
  return {w,h,data:out}}
let T=null;function crc32(buf){if(!T){T=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c}}let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++)c=T[(c^buf[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function encodePng(w,h,rgba){const stride=w*4;const raw=Buffer.alloc(h*(stride+1));
  for(let y=0;y<h;y++){raw[y*(stride+1)]=0;rgba.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride)}
  const idat=zlib.deflateSync(raw,{level:9});const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc])}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))])}
// 双线性缩放到目标边长
function resize(img,size){const {w,h,data}=img;const out=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const sx=(x+0.5)*w/size-0.5, sy=(y+0.5)*h/size-0.5;
    const x0=Math.max(0,Math.floor(sx)),x1=Math.min(w-1,x0+1),y0=Math.max(0,Math.floor(sy)),y1=Math.min(h-1,y0+1);
    const fx=Math.max(0,sx-x0),fy=Math.max(0,sy-y0);
    for(let c=0;c<4;c++){
      const p00=data[(y0*w+x0)*4+c],p10=data[(y0*w+x1)*4+c],p01=data[(y1*w+x0)*4+c],p11=data[(y1*w+x1)*4+c];
      out[(y*size+x)*4+c]=Math.round(p00*(1-fx)*(1-fy)+p10*fx*(1-fy)+p01*(1-fx)*fy+p11*fx*fy)}}
  return {w:size,h:size,data:out}}
const dir='electron/icons';const TARGET=256;
let before=0,after=0;
for(const f of fs.readdirSync(dir)){
  const p=path.join(dir,f);const st=fs.statSync(p);before+=st.size;
  const img=decodePng(fs.readFileSync(p));
  const r=img.w===TARGET&&img.h===TARGET?img:resize(img,TARGET);
  const buf=encodePng(r.w,r.h,r.data);fs.writeFileSync(p,buf);after+=buf.length;
}
console.log('icons: '+Math.round(before/1024)+'KB -> '+Math.round(after/1024)+'KB');