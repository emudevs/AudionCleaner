/// <reference types="vite/client" />
interface Window {
  acl: {
    nativeTitlebar:boolean;
    windowAction(action:'minimize'|'maximize'|'close'):Promise<boolean>;
    windowState():Promise<{maximized:boolean}>;
    onWindowState(callback:(state:{maximized:boolean})=>void):()=>void;
    request<T = unknown>(method: string, params?: Record<string, unknown>, id?: string): Promise<T>;
    openMedia(): Promise<{path: string; url: string} | null>;
    saveAudio(name: string): Promise<string|null>;
    saveProject(document:import('./projectFormat').ProjectDocument,existingPath?:string|null,saveAs?:boolean): Promise<{path:string}|null>;
    openProject(): Promise<{path:string;document:import('./projectFormat').ProjectDocument}|null>;
    registerMedia(path: string): Promise<string>;
    releaseMedia(url: string): Promise<boolean>;
    diagnostics(): Promise<{registeredMedia:number;pendingIpcRequests:number;electronMemory:unknown;processes:unknown[]}>;
    forceStopBackend(): Promise<{stopped:boolean}>;
    restartBackend(): Promise<{restarted:boolean}>;
    filePath(file: File): string;
    onEvent(callback: (message: AclEvent) => void): () => void;
  }
}
interface AclEvent {
  type: string;
  event: string;
  requestId?: string;
  peaks?: [number,number][];
  stage?: string;
  percent?: number;
  message?: string;
  protocol?: number;
  id?: string;
  error?: string;
  cancelled?: boolean;
}
