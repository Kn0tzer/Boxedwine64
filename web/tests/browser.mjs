import { chromium } from '@playwright/test';
import { serve } from '../../tools/browser/serve.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server=process.env.WINE_URL?null:await serve('dist');
const url=process.env.WINE_URL||`http://127.0.0.1:${server.address().port}/`;
await mkdir('test-results',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/local/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--use-angle=vulkan','--use-vulkan=swiftshader','--enable-features=Vulkan','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage();const errors=[],consoleLog=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{consoleLog.push(m.type()+': '+m.text());if(m.type()==='error'&&!m.text().startsWith('WARNING:'))console.log('BROWSER',m.text().slice(0,240));});
try{
  await page.goto(url);await page.waitForFunction(()=>window.wineLibrary);
  assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
  await page.screenshot({path:'test-results/launcher.png',fullPage:true});
  if (!process.env.SKIP_SHADERS) {
  await page.click('#translate');await page.waitForFunction(()=>document.getElementById('shaderResult').value.includes('@vertex'));
  await page.fill('#shaderSource','float4 main(float3 position : POSITION) : SV_Position { return float4(position, 1.0); }');
  await page.click('#hlsl');await page.waitForFunction(()=>document.getElementById('shaderResult').value.includes('@vertex'),{},{timeout:60000});
  console.log('PASS GLSL and HLSL compiler conversion');
  }
  if (!process.env.GPU_ONLY) {
  await page.click('[data-demo="notepad.exe"]');
  await page.waitForFunction(()=>document.getElementById('log').textContent.includes('first window mapped'),{},{timeout:180000});
  await page.waitForTimeout(10000);
  const frame=page.frames().find(f=>f.url().includes('/runtime/'));
  assert.ok(await frame.evaluate(()=>window.bwRuntime?.ready()));
  await page.screenshot({path:'test-results/notepad.png',fullPage:true});
  console.log('PASS real Windows Notepad window mapped');
  await page.click('#stop');
  }
  await page.selectOption('#backend','webgpu');await page.click('[data-demo="glcube.exe"]');
  await page.waitForFunction(()=>window.wineGpu?.frames>=5,{},{timeout:90000});
  const frames=await page.evaluate(()=>window.wineGpu.frames);await page.waitForTimeout(1500);assert.ok(await page.evaluate(()=>window.wineGpu.frames)>frames);
  assert.deepEqual(await page.evaluate(()=>window.wineGpu.errors),[]);
  await page.screenshot({path:'test-results/webgpu-cube.png',fullPage:true});
  console.log('PASS real guest OpenGL WebGPU frames: '+await page.evaluate(()=>window.wineGpu.frames));
  assert.deepEqual(errors,[]);
}catch(error){
  console.log('DIAGNOSTICS',await page.evaluate(()=>({status:document.getElementById('status').textContent,frames:window.wineGpu?.frames,gpuErrors:window.wineGpu?.errors,runtime:document.getElementById('runtimeStatus').textContent,fallback:document.getElementById('log').textContent.match(/WebGPU fallback:[^\n]*/)})));
  const runtime=page.frames().find(f=>f.url().includes('/runtime/'));
  if(runtime) console.log('RUNTIME',await runtime.evaluate(()=>({ready:window.bwRuntime?.ready(),gpu:typeof window.Module?.bwGpuFrame,capture:typeof window.Module?._bw64_gpu_capture,fs:!!window.bwRuntime?.fs()})));
  await page.screenshot({path:'test-results/failure.png',fullPage:true});
  throw error;
}finally{
  await writeFile('test-results/browser-console.log',consoleLog.join('\n'));
  await writeFile('test-results/browser-errors.json',JSON.stringify(errors,null,2));
  await browser.close();server?.close();
}
