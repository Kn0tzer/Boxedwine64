export const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
export function multiply(a, b) {
  const out = Array(16).fill(0);
  for (let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) out[c*4+r]+=a[k*4+r]*b[c*4+k];
  return out;
}
function transform(m, v) { return [0,1,2,3].map(r => m[r]*v[0]+m[4+r]*v[1]+m[8+r]*v[2]+m[12+r]); }
export class FixedGL {
  constructor() { this.matrices = new Map([[0x1700,[identity()]], [0x1701,[identity()]]]); this.mode=0x1700; this.color=[1,1,1,1]; this.clear=[0,0,0,1]; this.clearDepth=1; this.depth=false; this.depthWrite=true; this.depthFunc=0x201; this.cull=false; this.cullMode=0x405; this.front=0x901; this.viewport=null; this.primitive=null; }
  get stack() { const s=this.matrices.get(this.mode); if(!s) throw new Error('Unsupported matrix mode'); return s; }
  get matrix() { return this.stack.at(-1); }
  set matrix(m) { this.stack[this.stack.length-1]=m; }
  apply(m) { this.matrix=multiply(this.matrix,m); }
  decode(frame) {
    if(frame.overflow || !Array.isArray(frame.commands) || frame.commands.length>100000) throw new Error('Guest GPU command limit exceeded');
    const draws=[]; let clearMask=0;
    for(const command of frame.commands) {
      const [fn,...a]=command;
      if(a.some(v=>!Number.isFinite(v))) throw new Error('Invalid GL scalar');
      switch(fn) {
        case 200: this.clear=a; break;
        case 201: if(draws.length) throw new Error('Mid-frame clear not supported'); clearMask|=a[0]; break;
        case 202: this.clearDepth=Math.min(1,Math.max(0,a[0])); break;
        case 203: this.viewport=a; break;
        case 204: case 205: {
          const enabled=fn===204;
          if(a[0]===0xb71) this.depth=enabled;
          else if(a[0]===0xb44) this.cull=enabled;
          else if(a[0]!==0xbd0) throw new Error(`WebGPU subset does not implement GL capability 0x${a[0].toString(16)}`);
          break;
        }
        case 206: if(a[0]!==0x1d01) throw new Error('Flat shading not supported'); break;
        case 207: this.depthFunc=a[0]; break;
        case 208: this.cullMode=a[0]; break;
        case 209: this.front=a[0]; break;
        case 211: case 212: break;
        case 217: this.color=[...a,1]; break;
        case 218: this.color=a; break;
        case 260: this.mode=a[0]; if(!this.matrices.has(this.mode)) throw new Error('Texture matrices not supported'); break;
        case 261: this.matrix=identity(); break;
        case 262: if(this.stack.length>=64) throw new Error('Matrix stack overflow'); this.stack.push([...this.matrix]); break;
        case 263: if(this.stack.length===1) throw new Error('Matrix stack underflow'); this.stack.pop(); break;
        case 264: { const [l,r,b,t,n,f]=a; if(n<=0||f<=n||r===l||t===b) throw new Error('Invalid frustum'); this.apply([2*n/(r-l),0,0,0, 0,2*n/(t-b),0,0, (r+l)/(r-l),(t+b)/(t-b),-(f+n)/(f-n),-1, 0,0,-2*f*n/(f-n),0]); break; }
        case 265: { const [l,r,b,t,n,f]=a; if(r===l||t===b||f===n) throw new Error('Invalid orthographic matrix'); this.apply([2/(r-l),0,0,0, 0,2/(t-b),0,0, 0,0,-2/(f-n),0, -(r+l)/(r-l),-(t+b)/(t-b),-(f+n)/(f-n),1]); break; }
        case 266: { const m=identity(); m[12]=a[0];m[13]=a[1];m[14]=a[2];this.apply(m);break; }
        case 267: { let [angle,x,y,z]=a; const len=Math.hypot(x,y,z); if(!len) break; x/=len;y/=len;z/=len;const c=Math.cos(angle*Math.PI/180),s=Math.sin(angle*Math.PI/180),t=1-c;this.apply([t*x*x+c,t*x*y+s*z,t*x*z-s*y,0, t*x*y-s*z,t*y*y+c,t*y*z+s*x,0, t*x*z+s*y,t*y*z-s*x,t*z*z+c,0, 0,0,0,1]);break; }
        case 268: this.apply([a[0],0,0,0, 0,a[1],0,0, 0,0,a[2],0, 0,0,0,1]);break;
        case 269: if(a.length!==16) throw new Error('Invalid matrix');this.apply(a);break;
        case 320: if(this.primitive) throw new Error('Nested glBegin'); this.primitive={mode:a[0],vertices:[]};break;
        case 322: case 323: {
          if(!this.primitive) throw new Error('Vertex outside glBegin');
          const mv=this.matrices.get(0x1700).at(-1),proj=this.matrices.get(0x1701).at(-1);
          const clip=transform(multiply(proj,mv),[a[0],a[1],fn===323?a[2]:0,1]);
          clip[2]=(clip[2]+clip[3])*0.5; // OpenGL [-w,w] depth -> WebGPU [0,w].
          this.primitive.vertices.push([...clip,...this.color]);break;
        }
        case 321: {
          if(!this.primitive) throw new Error('glEnd without glBegin');
          const {mode,vertices}=this.primitive;const triangles=[];
          const add=(a,b,c)=>triangles.push(...vertices[a],...vertices[b],...vertices[c]);
          if(mode===4) {if(vertices.length%3) throw new Error('Incomplete triangle');for(let i=0;i<vertices.length;i+=3)add(i,i+1,i+2);}
          else if(mode===7) {if(vertices.length%4) throw new Error('Incomplete quad');for(let i=0;i<vertices.length;i+=4){add(i,i+1,i+2);add(i,i+2,i+3);}}
          else if(mode===5) {for(let i=2;i<vertices.length;i++)i%2?add(i-1,i-2,i):add(i-2,i-1,i);}
          else if(mode===6) {for(let i=2;i<vertices.length;i++)add(0,i-1,i);}
          else throw new Error(`Unsupported primitive ${mode}`);
          if(triangles.length) draws.push({vertices:new Float32Array(triangles),depth:this.depth,depthWrite:this.depthWrite,depthFunc:this.depthFunc,cull:this.cull,cullMode:this.cullMode,front:this.front,viewport:this.viewport});
          this.primitive=null;break;
        }
        case 535: this.depthWrite=!!a[0];break;
        default: throw new Error(`GL command ${fn} is outside the experimental WebGPU subset`);
      }
    }
    return {draws,clearMask,clear:[...this.clear],clearDepth:this.clearDepth};
  }
}
const wgsl=`struct Input { @location(0) position: vec4<f32>, @location(1) color: vec4<f32> };
struct Output { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> };
@vertex fn vs(input: Input) -> Output { var o: Output; o.position=input.position; o.color=input.color; return o; }
@fragment fn fs(input: Output) -> @location(0) vec4<f32> { return input.color; }`;
export async function createRenderer(canvas) {
  if(!navigator.gpu) throw new Error('WebGPU is unavailable');
  const adapter=await navigator.gpu.requestAdapter(); if(!adapter) throw new Error('No WebGPU adapter');
  const device=await adapter.requestDevice();
  const errors=[]; device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const context=canvas.getContext('webgpu');const format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST});
  const module=device.createShaderModule({code:wgsl});
  const diagnostics=await module.getCompilationInfo();if(diagnostics.messages.some(m=>m.type==='error')) throw new Error('WebGPU shader validation failed');
  const gl=new FixedGL();const pipelines=new Map();let depth,texture,w=0,h=0,frames=0,lost=false,destroyed=false;
  device.lost.then(info=>{lost=true;if(!destroyed)errors.push('Device lost: '+info.reason+' '+info.message);});
  const depthFuncs={512:'never',513:'less',514:'equal',515:'less-equal',516:'greater',517:'not-equal',518:'greater-equal',519:'always'};
  function render(frame) {
    if(lost) throw new Error('WebGPU device lost');
    const width=frame.width,height=frame.height;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096) throw new Error('Invalid guest render size');
    const decoded=gl.decode(frame);
    if(width!==w||height!==h){w=width;h=height;canvas.width=w;canvas.height=h;depth?.destroy();texture?.destroy();depth=device.createTexture({size:[w,h],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});texture=device.createTexture({size:[w,h],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});}
    // Persistent offscreen color/depth preserve GL load semantics across swaps.
    const encoder=device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:decoded.clear,loadOp:decoded.clearMask&0x4000?'clear':'load',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:decoded.clearDepth,depthLoadOp:decoded.clearMask&0x100?'clear':'load',depthStoreOp:'store'}});
    const buffers=[];
    for(const draw of decoded.draws){
      const compare=draw.depth?depthFuncs[draw.depthFunc]:'always';if(!compare) throw new Error('Invalid depth comparison');
      const cull=draw.cull?(draw.cullMode===0x404?'front':draw.cullMode===0x405?'back':null):'none';if(cull===null) throw new Error('Unsupported cull mode');
      const key=[compare,draw.depth&&draw.depthWrite,cull,draw.front].join(':');
      if(!pipelines.has(key))pipelines.set(key,device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs',buffers:[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:16,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:cull,frontFace:draw.front===0x900?'cw':'ccw'},depthStencil:{format:'depth24plus',depthWriteEnabled:draw.depth&&draw.depthWrite,depthCompare:compare}}));
      const buffer=device.createBuffer({size:draw.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,draw.vertices);buffers.push(buffer);
      pass.setPipeline(pipelines.get(key));pass.setVertexBuffer(0,buffer);
      if(draw.viewport){const[x,y,vw,vh]=draw.viewport;if(x<0||y<0||vw<=0||vh<=0||x+vw>w||y+vh>h)throw new Error('Viewport out of bounds');pass.setViewport(x,h-y-vh,vw,vh,0,1);}
      pass.draw(draw.vertices.length/8);
    }
    pass.end();encoder.copyTextureToTexture({texture},{texture:context.getCurrentTexture()},[w,h]);device.queue.submit([encoder.finish()]);
    const release=()=>buffers.forEach(b=>b.destroy());
    device.queue.onSubmittedWorkDone().then(release,release);frames++;
    return {frames,draws:decoded.draws.length};
  }
  return {render,errors,device,get frames(){return frames;},destroy(){destroyed=true;lost=true;context.unconfigure();depth?.destroy();texture?.destroy();device.destroy();}};
}
