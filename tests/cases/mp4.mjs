globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
const assert=(await import('node:assert')).default;
const { parseMp4Audio, sampleAt, resampleTo16k, parseEsds, codecString } = await import('./lib/mp4audio.js');
const { wavBlob } = await import('./lib/stt.js');
// ---- tiny MP4 builder
const u32=(n)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n>>>0);return b;}; const u16=(n)=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const box=(type,...c)=>{const body=Buffer.concat(c);return Buffer.concat([u32(8+body.length),Buffer.from(type),body]);};
const full=(type,...c)=>box(type,Buffer.alloc(4),...c);
const desc=(tag,...c)=>{const body=Buffer.concat(c);return Buffer.concat([Buffer.from([tag,body.length]),body]);};
const ASC=Buffer.from([0x12,0x10]); // AAC-LC, 44.1k, stereo
const esds=full('esds',desc(3,u16(1),Buffer.from([0]),desc(4,Buffer.from([0x40,0x15,0,0,0]),u32(0),u32(0),desc(5,ASC)),desc(6,Buffer.from([2]))));
const mp4a=box('mp4a',Buffer.alloc(6),u16(1),u16(0),u16(0),u32(0),u16(2),u16(16),u16(0),u16(0),u32(44100<<16),esds);
const stsd=full('stsd',u32(1),mp4a);
function build({chunks, perChunk, sizesArr, withVideo}){
  // layout: ftyp, mdat (video junk + audio chunks interleaved), moov at END (non-faststart)
  const ftyp=box('ftyp',Buffer.from('M4A '),u32(0),Buffer.from('M4A '));
  const parts=[]; const chunkOffsets=[]; let off=ftyp.length+8; let si=0; const sampleBytes=[];
  for(let c=0;c<chunks;c++){ if(withVideo){const v=Buffer.alloc(100,0xEE);parts.push(v);off+=100;} chunkOffsets.push(off); for(let k=0;k<perChunk;k++){const sz=sizesArr[si++]; const d=Buffer.alloc(sz,(si%250)+1); parts.push(d); off+=sz;}}
  const mdat=box('mdat',...parts);
  const n=chunks*perChunk;
  const stts=full('stts',u32(1),u32(n),u32(1024));
  const stsc=full('stsc',u32(1),u32(1),u32(perChunk),u32(1));
  const stsz=full('stsz',u32(0),u32(n),...sizesArr.slice(0,n).map(u32));
  const stco=full('stco',u32(chunks),...chunkOffsets.map(u32));
  const stbl=box('stbl',stsd,stts,stsc,stsz,stco);
  const mdhd=full('mdhd',u32(0),u32(0),u32(44100),u32(n*1024),u16(0x55c4),u16(0));
  const hdlr=full('hdlr',u32(0),Buffer.from('soun'),Buffer.alloc(12),Buffer.from('s\0'));
  const mdia=box('mdia',mdhd,hdlr,box('minf',stbl));
  const vtrak=box('trak',box('mdia',full('mdhd',u32(0),u32(0),u32(30000),u32(1000),u16(0),u16(0)),full('hdlr',u32(0),Buffer.from('vide'),Buffer.alloc(12),Buffer.from('v\0'))));
  const moov=box('moov',vtrak,box('trak',mdia));
  return {file:Buffer.concat([ftyp,mdat,moov]),mdatStart:ftyp.length};
}
const sizes=Array.from({length:60},(_,i)=>200+i*3);
const {file}=build({chunks:6,perChunk:10,sizesArr:sizes,withVideo:true});
const read=async(a,b)=>new Uint8Array(file.subarray(a,b));
const tr=await parseMp4Audio(read,file.length);
assert.ok(tr); assert.equal(tr.codec,'mp4a.40.2'); assert.equal(tr.sampleRate,44100); assert.equal(tr.channels,2); assert.equal(tr.count,60);
assert.deepEqual([...tr.description],[0x12,0x10]);
assert.ok(Math.abs(tr.duration-60*1024/44100)<1e-9); assert.ok(Math.abs(tr.times[10]-10*1024/44100)<1e-9);
// every sample's bytes are the audio bytes we wrote (value = index+1 pattern), video junk (0xEE) never touched
for(const i of [0,9,10,11,35,59]){ const b=file.subarray(tr.offsets[i],tr.offsets[i]+tr.sizes[i]); assert.equal(b.length,sizes[i]); assert.ok(b.every(x=>x===((i+1)%250)+1),'sample '+i); }
assert.equal(sampleAt(tr.times,0),0); assert.equal(sampleAt(tr.times,tr.times[20]),20); assert.equal(sampleAt(tr.times,1e9),60);
// no audio track / no moov
assert.equal(await parseMp4Audio(async(a,b)=>new Uint8Array(Buffer.concat([Buffer.alloc(8)]).subarray(a,b)),8),null);
// resample: 48k sine -> 16k keeps frequency; length ratio
const x=new Float32Array(48000); for(let i=0;i<x.length;i++) x[i]=Math.sin(2*Math.PI*440*i/48000);
const y=resampleTo16k(x,48000); assert.equal(y.length,16000);
let zc=0; for(let i=1;i<y.length;i++) if((y[i-1]<0)!==(y[i]<0)) zc++; assert.ok(Math.abs(zc/2-440)<4,'zc '+zc);
const z=resampleTo16k(new Float32Array(44100).fill(0.5),44100); assert.equal(z.length,16000); assert.ok(Math.abs(z[100]-0.5)<1e-6);
// wav
const wb=wavBlob(new Float32Array([0,0.5,-0.5])); const ab=new Uint8Array(await wb.arrayBuffer()); assert.equal(ab.length,44+6); assert.equal(String.fromCharCode(...ab.slice(0,4)),'RIFF');
console.log('mp4 ok', tr.duration.toFixed(2)+'s');
