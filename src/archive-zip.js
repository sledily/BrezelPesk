import { deflateRawSync } from 'node:zlib';

// Bounded, single-volume ZIP (Deflate), per PKWARE APPNOTE 6.3.10 sections
// 4.3.7, 4.3.12 and 4.3.16. No ZIP64, encryption or platform-specific metadata.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const table = Array.from({length:256},(_,i)=>{
  let n=i;for(let bit=0;bit<8;bit++) n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;
});
function crc32(bytes) {
  let n=0xffffffff;for(const byte of bytes)n=(n>>>8)^table[(n^byte)&255];return (n^0xffffffff)>>>0;
}
export function archiveZip(files, maxBytes = 128 * 1024 * 1024) {
  if(files.length>65535) throw new Error('Too many archive files');
  const locals=[],central=[],seen=new Set();let offset=0,total=0;
  for(const {name,content} of files) {
    if(!/^[A-Za-z0-9_/-]+\.(json|txt)$/.test(name) || name.startsWith('/') || seen.has(name)) throw new Error('Invalid archive filename');
    seen.add(name);
    const filename=Buffer.from(name),data=Buffer.from(content,'utf8');total+=data.length;
    if(total>maxBytes || filename.length>65535) throw new Error('Archive exceeds download limit');
    const packed=deflateRawSync(data),crc=crc32(data),local=Buffer.alloc(30),entry=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(8,8);local.writeUInt16LE(33,12); // 1980-01-01; authoritative dates live in each record.
    local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);local.copy(entry,6,4,30);
    entry.writeUInt32LE(offset,42);
    locals.push(local,filename,packed);central.push(entry,filename);offset+=local.length+filename.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
