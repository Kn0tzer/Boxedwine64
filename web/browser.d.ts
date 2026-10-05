interface Window {
  bwRuntime?: { fs(): any; ready(): boolean; call(name: string, types: string[], args: unknown[]): unknown };
  wineGpu?: any;
  wineLibrary?: any;
  wineGames?: any;
  // vk64 page tier (web/vkwebgpu.mjs, installed from web/runtime.html's
  // window.bwVkFrame hop or from web/app.mjs's 'vk' message branch).
  bwVkFrame?: (json: string) => void;
  bwVkTier?: any;
  bwVkTierReady?: Promise<any>;
  bwVkStats?: () => any;
  bwVkRenderer?: any;
}
interface FileSystemFileEntry extends FileSystemEntry { file(success: (file: File) => void, error?: (error: DOMException) => void): void; }
interface FileSystemDirectoryEntry extends FileSystemEntry { createReader(): FileSystemDirectoryReader; }
