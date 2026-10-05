import create from './slang/slang-wasm.js';
const compiler=await create();
const global=compiler.createGlobalSession();
const session=global.createSession(28);
const module=session.loadModuleFromSource('float4 main(float3 position : POSITION) : SV_Position { return float4(position, 1.0); }','test','test.hlsl');
console.log('module',module,compiler.getLastError());
if(module){
  const entry=module.findAndCheckEntryPoint('main',1);
  console.log('entry',entry,compiler.getLastError());
  if(entry){const composite=session.createCompositeComponentType([module,entry]);console.log('composite',composite,compiler.getLastError());if(composite){const linked=composite.link();console.log('linked',linked,compiler.getLastError());if(linked)console.log(linked.getEntryPointCode(0,0));}}
}
