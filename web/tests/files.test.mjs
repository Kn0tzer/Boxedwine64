import test from 'node:test';
import assert from 'node:assert/strict';
import { safePath,checkEntries,stripRoot,makeZip,fromZip,peArchitecture,limits } from '../files.mjs';
import { ZipWriter,BlobWriter,BlobReader } from '../vendor/zip/index-native.js';
test('reject traversal, absolute paths, Windows aliases and control characters',()=>{
  for(const p of ['../escape.exe','a/../escape','/absolute','C:/a','a\\b','a//b','a/./b','a\n.exe','CON.txt','nul','com1.exe','a.','a '])assert.throws(()=>safePath(p),undefined,p);
  assert.equal(safePath('Game assets/日本語/data.bin'),'Game assets/日本語/data.bin');
});
test('enforce expansion, count and case insensitive collision budgets',()=>{
  assert.throws(()=>checkEntries([{path:'a',size:limits.file+1}]));
  assert.throws(()=>checkEntries([{path:'App.exe',size:1},{path:'app.exe',size:1}]));
  assert.throws(()=>checkEntries([{path:'assets',size:1},{path:'assets/x',size:1}]));
  assert.throws(()=>checkEntries([{path:'x',size:NaN}]));
});
test('strip exactly one common enclosing folder without flattening siblings',()=>{
  assert.deepEqual(stripRoot([{path:'Game/app.exe'},{path:'Game/data/a'}]).map(e=>e.path),['app.exe','data/a']);
  assert.equal(stripRoot([{path:'app.exe'},{path:'data/a'}])[1].path,'data/a');
});
test('ZIP export/import preserves UTF-8 names and contents',async()=>{
  const blob=new Blob(['saved text']);const input=[{path:'游戏/save.txt',size:blob.size,blob}];
  const output=await fromZip(await makeZip(input),{strip:false});
  assert.equal(output[0].path,input[0].path);assert.equal(await output[0].blob.text(),'saved text');
});
test('archive traversal rejected before extraction',async()=>{
  const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false});await writer.add('../escape.exe',new BlobReader(new Blob(['bad'])),{level:0});
  await assert.rejects(fromZip(await writer.close()),/Unsafe/);
});
test('PE detection validates header and distinguishes x64/x86',async()=>{
  const data=new Uint8Array(128),v=new DataView(data.buffer);v.setUint16(0,0x5a4d,true);v.setUint32(60,64,true);v.setUint32(64,0x4550,true);v.setUint16(68,0x8664,true);
  assert.equal(await peArchitecture(new Blob([data])),'x64');v.setUint16(68,0x14c,true);assert.equal(await peArchitecture(new Blob([data])),'x86');
  v.setUint32(60,10000,true);await assert.rejects(peArchitecture(new Blob([data])));await assert.rejects(peArchitecture(new Blob(['not an exe'])));
});
