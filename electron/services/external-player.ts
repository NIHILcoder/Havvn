import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ExternalMedia, ExternalMediaRead, ExternalPlayerSession } from '../../shared/external-player';
import { spawn, type ChildProcess } from 'node:child_process';
import { classifyMediaKind } from '../../shared/media';
import { externalStartTime, type ExternalPlayerPreferences, type ExternalPlayerConfig, type ExternalPlayerChoice, type ExternalPlayerResult, type ExternalPlayerFailure } from '../../shared/external-player';

export type LocalMedia = { ok: true; disk: string; length: number } | { ok: false; reason: ExternalPlayerFailure };
interface Dependencies {
  read: () => unknown;
  write: (value: ExternalPlayerPreferences) => void;
  resolve: (id: string, relativePath: string) => Promise<LocalMedia>;
  openPath: (file: string) => Promise<string>;
  spawn?: (exe: string, args: string[]) => ChildProcess;
}
const defaults: ExternalPlayerPreferences = { kind: 'default', executable: null };
function playerKind(executable: string): 'vlc' | 'mpv' | null {
  const name = path.basename(executable).toLowerCase();
  if (name === (process.platform === 'win32' ? 'vlc.exe' : 'vlc')) return 'vlc';
  if (name === (process.platform === 'win32' ? 'mpv.exe' : 'mpv')) return 'mpv';
  return null;
}
function executableExists(file: string): boolean {
  try { if (!path.isAbsolute(file) || file.includes('\0') || !fs.statSync(file).isFile()) return false;
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK); return true;
  } catch { return false; }
}function mediaPath(value: string): string | null {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) return null;
  const rel = value.replace(/\\/g, '/');
  return !rel || path.isAbsolute(rel) || rel.includes(':') || rel.split('/').some(p => !p || p === '.' || p === '..') || classifyMediaKind(rel) === 'other' ? null : rel;
}

export class ExternalPlayer {
private closed=false;
constructor(private readonly deps: Dependencies) {}
getConfig(): ExternalPlayerConfig {
    const raw = this.deps.read() as Partial<ExternalPlayerPreferences> | null;
    const selected = raw && (raw.kind === 'vlc' || raw.kind === 'mpv') && typeof raw.executable === 'string';
    const prefs: ExternalPlayerPreferences = selected ? { kind: raw.kind as 'vlc' | 'mpv', executable: raw.executable! } : defaults;
    return { ...prefs, available: prefs.kind === 'default' || (!!prefs.executable && playerKind(prefs.executable) === prefs.kind && executableExists(prefs.executable)) };
  }
useDefault(): ExternalPlayerConfig { this.deps.write({ ...defaults }); return this.getConfig(); }
select(file: string): ExternalPlayerChoice {
    const kind = playerKind(file);
    if (!kind) return { ok: false, reason: 'unsupported-player' };
    if (!executableExists(file)) return { ok: false, reason: 'missing-player' };
    this.deps.write({ kind, executable: file });
    return { ok: true, config: this.getConfig() };
  }
async inspect(id:string,rel:string):Promise<'local'|'stream'|ExternalPlayerFailure>{const file=await this.deps.resolve(id,rel);return file.ok?'local':file.reason}
sessions():ExternalPlayerSession[]{return []}
stop(_id:string):void{}
close():void{this.closed=true}
async open(id:string,relativePath:string,position?:number):Promise<ExternalPlayerResult>{
 const rel=mediaPath(relativePath);if(!rel)return{ok:false,reason:'invalid-file'};
 try{if(this.closed)return{ok:false,reason:'unavailable'};const file=await this.deps.resolve(id,rel);if(!file.ok)return file;
 const config=this.getConfig(),startTime=config.kind==='default'?0:externalStartTime(position);if(!config.available)return{ok:false,reason:'missing-player'};
 if(!path.isAbsolute(file.disk)||classifyMediaKind(file.disk)==='other')return{ok:false,reason:'invalid-file'};
 try{const stat=fs.statSync(file.disk);if(!stat.isFile())return{ok:false,reason:'invalid-file'};if(stat.size<file.length)return{ok:false,reason:'incomplete-file'}}catch{return{ok:false,reason:'missing-file'}}
 if(config.kind==='default'){if(await this.deps.openPath(file.disk).catch(()=>'Failed'))return{ok:false,reason:'launch-failed'}}else{
 const args=config.kind==='mpv'?[...(startTime?['--start='+startTime]:[]),'--',file.disk]:[...(startTime?['--start-time='+startTime]:[]),file.disk];
 const ok=await new Promise<boolean>(resolve=>{const child=this.deps.spawn?this.deps.spawn(config.executable!,args):spawn(config.executable!,args,{shell:false,windowsHide:true,detached:true,stdio:'ignore'});
 let settled=false,timer:ReturnType<typeof setTimeout>|undefined;const finish=(success:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);child.unref();resolve(success)};
 child.once('error',()=>finish(false));child.once('exit',(code,signal)=>finish(code===0&&!signal));child.once('spawn',()=>{timer=setTimeout(()=>finish(!this.closed),500)});
 }).catch(()=>false);if(!ok)return{ok:false,reason:'launch-failed'}}return{ok:true,kind:config.kind,startTime};
 }catch{return{ok:false,reason:'unavailable'}}
}
}
