import test from 'node:test';
import assert from 'node:assert/strict';
import { FixedGL,identity,multiply } from '../webgpu.mjs';
test('column-major matrix multiplication preserves identity',()=>assert.deepEqual(multiply(identity(),identity()),identity()));
test('guest quads triangulate and depth converts from GL to WebGPU',()=>{
  const gl=new FixedGL();const frame=gl.decode({commands:[[260,0x1700],[261],[217,1,0,0],[320,7],[323,-1,-1,0],[323,1,-1,0],[323,1,1,0],[323,-1,1,0],[321]]});
  assert.equal(frame.draws[0].vertices.length,6*8);assert.equal(frame.draws[0].vertices[2],.5);assert.equal(frame.draws[0].vertices[4],1);
});
test('matrix and current color persist across frame boundaries',()=>{
  const gl=new FixedGL();gl.decode({commands:[[266,2,3,4],[218,0,1,0,1]]});const frame=gl.decode({commands:[[320,4],[323,0,0,0],[323,1,0,0],[323,0,1,0],[321]]});
  assert.deepEqual(Array.from(frame.draws[0].vertices.slice(0,8)),[2,3,2.5,1,0,1,0,1]);
});
test('unsupported shader/texture/light state fails instead of silently rendering wrong',()=>{
  for(const commands of [[[410,0]],[[204,0xb50]],[[320,1],[321]],[[263]],[[320,4],[320,4]]])assert.throws(()=>new FixedGL().decode({commands}));
  assert.throws(()=>new FixedGL().decode({overflow:true,commands:[]}));
});
