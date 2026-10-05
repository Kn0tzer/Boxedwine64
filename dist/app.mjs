import { fromFiles, fromDrop, fromZip, makeZip, peArchitecture, safePath, checkEntries } from './files.mjs';
import { listPackages, getPackage, savePackage, deletePackage, overlay } from './storage.mjs';
import { createRenderer } from './webgpu.mjs';
import { toWGSL } from './shader.mjs';
import { builtinGames, fetchGameArchive, formatBytes } from './games.mjs';
/** @type {(id: string) => HTMLElement & {value: string, disabled: boolean, files: FileList, options: HTMLOptionsCollection, add(option: HTMLOptionElement): void}} */
const $=id=>/** @type {any} */(document.getElementById(id));
const IDLE_CARD_STATE='Download and install on this device';
let selected=null,iframe=null,renderer=null,busy=false;
const report=text=>{$('status').textContent=text;};
function log(text){$('log').textContent=($('log').textContent+'\n'+text).slice(-48000);}
async function guard(fn){if(busy)return;busy=true;try{await fn();}catch(e){report(e.message||String(e));}finally{busy=false;}}
async function refresh(id=selected?.id){
  const packages=await listPackages();$('library').replaceChildren(new Option('Select an installation',''));
  for(const pkg of packages)$('library').add(new Option(pkg.name,pkg.id));
  $('library').value=id||'';await select(id);
}
async function select(id){
  selected=id?await getPackage(id):null;$('executable').replaceChildren();
  for(const f of selected?.files||[])if(/\.exe$/i.test(f.path))$('executable').add(new Option(f.path,f.path));
  for(const control of ['patch','export','restore','remove'])$(control).disabled=!selected;
  $('start').disabled=!selected||!$('executable').value;
}
async function install(files,name,game){
  checkEntries(files);
  if(!files.some(f=>/\.exe$/i.test(f.path)))throw new Error('No .exe was found in the folder');
  // Validate the catalog entry point before anything is persisted: an archive
  // that lacks it must fail cleanly, without storing a package that cannot be
  // started (and without leaving a duplicate behind on every retry).
  if(game&&!files.some(f=>f.path===game.exe))throw new Error(`${game.exe} is absent from the downloaded archive`);
  const pkg={id:crypto.randomUUID(),name:name||'Imported folder',files,created:new Date().toISOString()};
  await savePackage(pkg);await navigator.storage.persist?.();await refresh(pkg.id);
  if(!game)return report(`Imported ${files.length} files. Select the executable and press Start.`);
  // Preselect the game's entry point, but keep the picker authoritative: any
  // other .exe in the package stays selectable and overrides this choice.
  $('executable').value=game.exe;$('start').disabled=false;
  const args=$('arguments').value.trim();
  if(game.args&&(!args||args==='[]'))$('arguments').value=JSON.stringify(game.args);
  report(`Imported ${game.title}: ${files.length} files, ${game.exe} selected. Override in the picker if needed, then press Start.`);
}
function renderCatalog(){
  for(const game of builtinGames){
    const card=document.createElement('button');
    card.type='button';card.className='gamecard';card.dataset.game=game.id;
    const title=document.createElement('strong');title.textContent=game.title;
    const meta=document.createElement('span');meta.className='gamemeta';meta.textContent=`${game.engine} · ${game.note}`;
    const bar=document.createElement('span');bar.className='bar';
    const fill=document.createElement('i');bar.append(fill);
    const state=document.createElement('span');state.className='gamestate';state.textContent=IDLE_CARD_STATE;
    card.append(title,meta,bar,state);
    card.onclick=()=>guard(()=>importGame(game,card));
    $('gameCatalog').append(card);
  }
}
async function importGame(game,card){
  const IDLE=IDLE_CARD_STATE;
  if(!card||!game||card.disabled)return;
  const state=card.querySelector('.gamestate'),fill=card.querySelector('.bar>i');
  const meter=(received,total)=>{
    const pct=total?Math.min(100,Math.round(received/total*100)):0;
    fill.style.width=pct+'%';
    state.textContent=total?`Downloading ${formatBytes(received)} / ${formatBytes(total)} (${pct}%)`:`Downloading ${formatBytes(received)}`;
    report(`${game.title}: downloading ${pct}%`);
  };
  // Every path below leaves through the finally, which owns the card state:
  // aria-busy, disabled and the meter are restored here so a failed or
  // superseded import cannot leave the card wedged mid-download.
  card.disabled=true;card.setAttribute('aria-busy','true');
  let installed=false,failure=null;
  try{
    const blob=await fetchGameArchive(game,meter);
    fill.style.width='100%';state.textContent=`Extracting ${formatBytes(blob.size)}…`;report(`Extracting ${game.title}…`);
    await install(await fromZip(blob),game.title,game);
    installed=true;state.textContent='Installed';card.classList.add('done');
  }catch(e){
    failure=e;throw e;
  }finally{
    card.disabled=false;card.removeAttribute('aria-busy');
    if(installed){state.textContent='Installed';card.classList.add('done');}
    else{
      card.classList.remove('done');fill.style.width='0%';
      state.textContent=failure&&/cancelled by a newer request/.test(failure.message||'')?IDLE:'Import failed: '+(failure?failure.message||failure:'unknown error');
    }
  }
}
function persistenceDb(id){return 'bw64persist-wine-'+id;}
async function storedFiles(id){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(persistenceDb(id),1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onerror=()=>reject(r.error);
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('files','readonly'),records=[];const cur=tx.objectStore('files').openCursor();cur.onsuccess=()=>{const c=cur.result;if(c){records.push({path:String(c.key),data:c.value.data});c.continue();}};tx.oncomplete=()=>{db.close();resolve(records);};tx.onerror=()=>{db.close();reject(tx.error);};};
  });
}
async function writeStored(id,entries,replace=false){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(persistenceDb(id),1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onerror=()=>reject(r.error);
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('files','readwrite'),s=tx.objectStore('files');if(replace)s.clear();for(const e of entries)s.put({data:e.data,sig:Date.now()+':'+e.data.length},e.path);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};};
  });
}
async function snapshot(){
  if(!iframe)return;
  const win=iframe.contentWindow,FS=win.bwRuntime?.fs();if(!FS)return;
  const files=[];let size=0;
  function walk(dir){let names;try{names=FS.readdir(dir);}catch{return;}for(const n of names){if(n==='.'||n==='..'||n.startsWith('.bw64clip'))continue;const path=dir+'/'+n,st=FS.lstat(path);if(FS.isDir(st.mode))walk(path);else if(FS.isFile(st.mode)){size+=st.size;if(size>768*1024**2||files.length>=20000)throw new Error('Save tree exceeds backup limits');files.push({path,data:FS.readFile(path)});}}}
  walk('/root/home/username');await writeStored(iframe.dataset.installation,files,true);
}
async function stop(){await snapshot();iframe?.remove();iframe=null;renderer?.destroy();renderer=null;$('gpuCanvas')?.remove();$('stop').disabled=true;}
async function launch(prog,{pkg=null,exe=null,args=[]}={}){
  await stop();$('log').textContent='';$('placeholder')?.remove();
  const gpu=$('backend').value==='webgpu';
  if(gpu){const canvas=document.createElement('canvas');canvas.id='gpuCanvas';$('display').append(canvas);try{renderer=await createRenderer(canvas);window.wineGpu=renderer;}catch(e){canvas.remove();throw e;}}
  iframe=document.createElement('iframe');iframe.title='Windows program runtime';iframe.allow='cross-origin-isolated; fullscreen';iframe.dataset.installation=pkg?.id||'demo';
  const q=new URLSearchParams({p:prog,installation:pkg?.id||'demo',gpu:gpu?'1':'0',gltrace:'0',session:'0'});
  if(exe){q.set('exe',exe);q.set('args',JSON.stringify(args));}
  iframe.src='runtime/index.html?'+q;$('display').append(iframe);$('stop').disabled=false;report('Booting Wine. First launch can take 30–120 seconds.');
  setTimeout(()=>iframe?.contentWindow?.document.getElementById('canvas')?.focus(),1000);
}
window.addEventListener('message',e=>{
  if(e.origin!==location.origin||e.source!==iframe?.contentWindow||!e.data?.wine)return;
  const {type,data}=e.data;
  if(type==='status')$('runtimeStatus').textContent=String(data);
  if(type==='log'){log(String(data));if(String(data).includes('first window mapped'))report('Guest window mapped. Rendering…');}
  if(type==='gpu'&&renderer){try{const result=renderer.render(data);report(`Real guest OpenGL → WebGPU · ${result.frames} frames`);}catch(err){log('WebGPU fallback: '+err.message);console.warn('WebGPU fallback: '+err.message);report('Unsupported WebGPU command; showing upstream WebGL rendering.');renderer.destroy();renderer=null;$('gpuCanvas')?.remove();}}
  // vk64 page tier (tasks/p1-final.md §2.9): the sibling of the 'gpu' branch. The
  // guest's Vulkan frame manifest is rendered by web/vkwebgpu.mjs into its own
  // canvas; any error falls back to the upstream rendering exactly like 'gpu'.
  if(type==='vk'){const ready=window.bwVkTierReady||(window.bwVkTierReady=import('./vkwebgpu.mjs').then(m=>(window.bwVkTier=m.installVkPageTier())));ready.then(t=>t.frame(data)).then(()=>report(`Real guest Vulkan → WebGPU · ${window.bwVkStats?.().rendered||0} frames`)).catch(err=>{log('WebGPU Vulkan fallback: '+err.message);console.warn('WebGPU Vulkan fallback: '+err.message);report('Unsupported Vulkan frame; showing upstream rendering.');});}
  // Schema v2 (tasks/schema-v2.md): binary chunks arrive via window.bwVkChunk
  // in the runtime page; the tier queues them (drop-oldest, latest-frame-wins).
  if(type==='vk2'){const ready=window.bwVkTierReady||(window.bwVkTierReady=import('./vkwebgpu.mjs').then(m=>(window.bwVkTier=m.installVkPageTier())));ready.then(t=>t.chunk(data.bytes, data.flags)).then(()=>report(`Real guest Vulkan → WebGPU · ${window.bwVkStats?.().v2?.rendered||0} v2 frames`)).catch(err=>{log('WebGPU Vulkan fallback: '+err.message);console.warn('WebGPU Vulkan fallback: '+err.message);report('Unsupported Vulkan frame; showing upstream rendering.');});}
});
$('folderButton').onclick=()=>$('folderInput').click();$('zipButton').onclick=()=>$('zipInput').click();
$('folderInput').onchange=()=>guard(async()=>{report('Importing folder…');const files=await fromFiles($('folderInput').files);const name=$('folderInput').files[0]?.webkitRelativePath.split('/')[0];await install(files,name);$('folderInput').value='';});
$('zipInput').onchange=()=>guard(async()=>{const file=$('zipInput').files[0];if(!file)return;report('Reading package…');await install(/\.zip$/i.test(file.name)?await fromZip(file):await fromFiles([file]),file.name.replace(/\.(zip|exe)$/i,''));$('zipInput').value='';});
$('drop').onclick=()=>$('folderInput').click();$('drop').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('folderInput').click();}};
$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('over');};$('drop').ondragleave=()=>$('drop').classList.remove('over');
$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('over');const items=Array.from(e.dataTransfer.items);const files=Array.from(e.dataTransfer.files);guard(async()=>{report('Importing drop…');if(files.length===1&&/\.zip$/i.test(files[0].name))await install(await fromZip(files[0]),files[0].name);else await install(await fromDrop(items),files[0]?.name||'Dropped folder');});};
$('library').onchange=()=>guard(()=>select($('library').value));$('executable').onchange=()=>{$('start').disabled=!$('executable').value;};
$('start').onclick=()=>guard(async()=>{const exe=safePath($('executable').value),file=selected.files.find(f=>f.path===exe);const arch=await peArchitecture(file.blob);if(arch!=='x64')throw new Error('This runtime currently requires a 64-bit EXE. 32-bit/WoW64 is not certified.');const args=JSON.parse($('arguments').value);if(!Array.isArray(args)||args.some(a=>typeof a!=='string'||/[\x00-\x1f]/.test(a)))throw new Error('Arguments must be a JSON array of strings');await launch('uploaded.exe',{pkg:selected,exe,args});});
$('stop').onclick=()=>guard(async()=>{await stop();report('Stopped; writable files saved locally.');});
for(const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('button[data-demo]')))button.onclick=()=>guard(()=>launch(button.dataset.demo));
$('fullscreen').onclick=()=>guard(()=>$('display').requestFullscreen());
$('patch').onclick=()=>$('patchInput').click();
$('patchInput').onchange=()=>guard(async()=>{const file=$('patchInput').files[0];if(!file||!selected)return;const patch=await fromZip(file,{strip:false});await stop();selected=await overlay(selected,patch);await writeStored(selected.id,await Promise.all(patch.map(async f=>({path:'/root/home/username/apps/'+f.path,data:new Uint8Array(await f.blob.arrayBuffer())}))));await refresh(selected.id);report(`Applied ${patch.length} patch files. Start again to use them.`);$('patchInput').value='';});
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),10000);}
$('export').onclick=()=>guard(async()=>{await snapshot();const stored=await storedFiles(selected.id);const files=selected.files.map(f=>({...f,path:'package/'+f.path}));for(const e of stored){if(!e.path.startsWith('/root/home/username/'))throw new Error('Invalid persisted save path');files.push({path:'writable/'+safePath(e.path.slice('/root/home/username/'.length)),size:e.data.length,blob:new Blob([e.data])});}download(await makeZip(files),selected.name+'-backup.zip');report('Backup exported: package, saves, registry and app profile.');});
$('restore').onclick=()=>$('restoreInput').click();
$('restoreInput').onchange=()=>guard(async()=>{const entries=await fromZip($('restoreInput').files[0],{strip:false});if(entries.some(e=>!e.path.startsWith('package/')&&!e.path.startsWith('writable/')))throw new Error('Not a Wine launcher backup');const files=entries.filter(e=>e.path.startsWith('package/')).map(e=>({...e,path:safePath(e.path.slice(8))}));checkEntries(files);const saves=await Promise.all(entries.filter(e=>e.path.startsWith('writable/')).map(async e=>({path:'/root/home/username/'+safePath(e.path.slice(9)),data:new Uint8Array(await e.blob.arrayBuffer())})));await stop();await savePackage({...selected,files});await writeStored(selected.id,saves,true);await refresh(selected.id);report('Backup restored. Press Start.');$('restoreInput').value='';});
$('remove').onclick=()=>guard(async()=>{if(!confirm('Delete this imported folder and its local saves?'))return;await stop();const id=selected.id;await deletePackage(id);await new Promise((ok,fail)=>{const r=indexedDB.deleteDatabase(persistenceDb(id));r.onsuccess=ok;r.onerror=()=>fail(r.error);r.onblocked=()=>fail(new Error('Close other tabs running this installation'));});selected=null;await refresh();report('Installation deleted.');});
async function compile(from,source){$('shaderResult').value='Compiling…';try{const code=await toWGSL(from,source,/** @type {'vertex'|'fragment'|'compute'} */($('shaderStage').value));$('shaderResult').value=code;if(navigator.gpu){const adapter=await navigator.gpu.requestAdapter();if(adapter){const device=await adapter.requestDevice();const info=await device.createShaderModule({code}).getCompilationInfo();device.destroy();const errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw new Error(errors.map(e=>e.message).join('\n'));}}}catch(e){$('shaderResult').value=e.formatted||e.message||String(e);}}
$('translate').onclick=()=>guard(()=>compile('glsl',$('shaderSource').value));
$('hlsl').onclick=()=>guard(()=>compile('hlsl',$('shaderSource').value));
$('spirv').onchange=()=>guard(async()=>{const file=$('spirv').files[0];if(file)await compile('spirv',new Uint8Array(await file.arrayBuffer()));});
$('capability').textContent=crossOriginIsolated&&typeof SharedArrayBuffer!=='undefined'?'WASM threads ready · '+(navigator.gpu?'WebGPU detected':'WebGL2'):'Missing cross-origin isolation';
await refresh();
renderCatalog();
window.wineLibrary={getPackage,listPackages};
window.wineGames={catalog:builtinGames,install:(id)=>guard(()=>importGame(builtinGames.find(g=>g.id===id),document.querySelector(`[data-game="${id}"]`)))};
