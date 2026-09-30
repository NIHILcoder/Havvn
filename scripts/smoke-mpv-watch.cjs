// Isolated Windows process implementing mpv JSON IPC, not an mpv media decoder.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-mpv-watch-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  let player, history, win;
  const deadline = setTimeout(() => { console.error('mpv history deadline'); player?.close(); history?.close(); app.exit(1); }, 65000);
  app.whenReady().then(async () => {
    assert.equal(process.platform, 'win32');
    const cs = path.join(out, 'MpvFixture.cs'), exe = path.join(out, 'mpv.exe'), clock = path.join(out, 'clock.txt');
    fs.writeFileSync(cs, `using System; using System.IO; using System.IO.Pipes; using System.Text; using System.Collections.Generic; using System.Web.Script.Serialization;
class MpvFixture {
 static int Main(string[] args) {
  string endpoint=null, source=args[args.Length-1], root=AppDomain.CurrentDomain.BaseDirectory;
  foreach(string arg in args) if(arg.StartsWith("--input-ipc-server=")) endpoint=arg.Substring(19);
  File.WriteAllLines(Path.Combine(root,"argv.txt"),args); if(endpoint==null) return 2;
  var json=new JavaScriptSerializer();
  using(var pipe=new NamedPipeServerStream(endpoint.Substring(9),PipeDirection.InOut,1,PipeTransmissionMode.Byte)) {
   pipe.WaitForConnection();
   using(var reader=new StreamReader(pipe,new UTF8Encoding(false))) using(var writer=new StreamWriter(pipe,new UTF8Encoding(false))) {
    writer.AutoFlush=true; writer.WriteLine("{\\"event\\":\\"file-loaded\\"}"); string line;
    while((line=reader.ReadLine())!=null) {
     var request=(Dictionary<string,object>)json.DeserializeObject(line); var command=(object[])request["command"];
     if((string)command[0]!="get_property") return 3;
     string[] values; try { values=File.ReadAllLines(Path.Combine(root,"clock.txt")); } catch { continue; }
     double time,total; if(values.Length<2 || !double.TryParse(values[0],System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out time) || !double.TryParse(values[1],out total)) continue;
     object data=null; switch((string)command[1]) { case "path": data=values.Length>2?values[2]:source; break; case "time-pos": data=time; break; case "duration": data=total>0?(object)total:null; break; default: return 4; }
     writer.WriteLine(json.Serialize(new Dictionary<string,object>{{"request_id",request["request_id"]},{"error","success"},{"data",data}}));
    }
   }
  }
  return 0;
 }
}`);
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    require('node:child_process').execFileSync(csc, ['/nologo', '/target:exe', '/r:System.Web.Extensions.dll', '/out:' + exe, cs], { windowsHide: true, timeout: 15000 });
    const name = 'Серия & 01.mp4', disk = path.join(out, name); fs.writeFileSync(disk, '0123456789');
    const download = { id: 'test', infoHash: 'hash', name: 'Series', status: 'paused', progress: 1, savePath: out };
    const files = [{ name, path: name, index: 7, length: 10, downloaded: 10, progress: 1 }];
    history = new (require(path.join(root, 'dist/electron/electron/services/history-playback.js')).HistoryPlayback)({
      download: async () => download, files: async () => files, cached: () => [], cache: () => {}, ffmpeg: () => null, stream: async () => { throw Error('Must not resume torrents'); },
    });
    const Store = require('electron-store'), store = new Store({ name: 'watch-fixture', defaults: { updates: [] } });
    const Queue = require(path.join(root, 'dist/electron/electron/services/external-watch-queue.js')).ExternalWatchQueue;
    let queue = new Queue(() => store.get('updates'), updates => store.set('updates', updates));
    player = new (require(path.join(root, 'dist/electron/electron/services/external-player.js')).ExternalPlayer)({
      read: () => ({ kind: 'mpv', executable: exe }), write: () => {}, openPath: async () => { throw Error('Wrong player'); },
      resolve: (id, rel) => history.localFile(id, rel), watchTarget: (id, rel) => history.watchTarget(id, rel),
      saveWatch: (launch, entry, session) => queue.push(launch, entry, session),
    });
    ipcMain.handle('watch:target', (_e, id, rel) => history.watchTarget(id, rel));
    ipcMain.handle('watch:open', (_e, ...args) => player.open(...args));
    ipcMain.handle('watch:updates', () => queue.list()); ipcMain.handle('watch:ack', (_e, ids) => queue.acknowledge(ids));
    const page = path.join(out, 'preview.html'); fs.writeFileSync(page, '<html><div id="root"></div></html>');
    win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true } });
    await win.loadFile(page);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('Renderer step:', code); throw error; } };
    const wait = async (condition, label) => { for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Wait failed: ' + label); };
    const bootstrap = `
      var fs=require('fs'),path=require('path'),root=${JSON.stringify(root)},ts=require(path.join(root,'node_modules/typescript')),cache={},ipc=require('electron').ipcRenderer;
      function load(p){if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);return load(q+'.ts')}return require(path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var watchHistory=load(path.join(root,'renderer/utils/watchHistory.ts')),receiver=load(path.join(root,'renderer/utils/externalWatch.ts'));
      var api={watchTarget:(id,rel)=>ipc.invoke('watch:target',id,rel),open:(...args)=>ipc.invoke('watch:open',...args),watchUpdates:()=>ipc.invoke('watch:updates'),acknowledgeWatch:ids=>ipc.invoke('watch:ack',ids)};
      var dispose=()=>{};
    `;
    await run(bootstrap);
    const setClock = (position, duration = 1000, source) => fs.writeFileSync(clock, `${position}\n${duration}${source ? '\n' + source : ''}`);
    setClock(123.5);
    const result = await run(`(async()=>{var target=await api.watchTarget('test',${JSON.stringify(name)});var builtin=watchHistory.beginPlaybackWatch(target.identity,target.path);
      watchHistory.saveWatch({...target,position:42,duration:1000,completed:false,lastOpened:Date.now(),updatedAt:Date.now(),tracks:{audio:'descriptor',subtitle:'off',at:1},nextPath:'Series/02.mp4'},builtin);
      var session=watchHistory.beginPlaybackWatch(target.identity,target.path);var result=await api.open('test',${JSON.stringify(name)},42,session);dispose=receiver.receiveExternalWatch(api);return result})()`);
    assert.equal(result.ok, true);
    await wait(() => run(`watchHistory.watchEntries()[0]?.position===123.5`), 'real Windows JSON IPC to renderer history');
    const argv = fs.readFileSync(path.join(out, 'argv.txt'), 'utf8').trim().split(/\r?\n/);
    assert(argv[0].startsWith('--input-ipc-server=\\\\.\\pipe\\havvn-mpv-')); assert.deepEqual(argv.slice(-3), ['--start=42', '--', disk]);
    assert.deepEqual(await run(`watchHistory.watchEntries()[0].tracks`), { audio: 'descriptor', subtitle: 'off', at: 1 });
    setClock(7.25, 0); await wait(() => run(`watchHistory.watchEntries()[0]?.position===7.25&&watchHistory.watchEntries()[0]?.duration===null`), 'backward seek and unknown duration');
    await run('dispose()'); setClock(200);
    await wait(async () => queue.list().some(u => u.entry.position === 200), 'pending queue');
    queue = new Queue(() => new Store({ name: 'watch-fixture' }).get('updates'), updates => store.set('updates', updates));
    await win.reload(); await wait(() => run('document.readyState===\'complete\''), 'renderer reload'); await run(bootstrap);
    await run('dispose=receiver.receiveExternalWatch(api);void 0'); await wait(() => run('watchHistory.watchEntries()[0]?.position===200'), 'persistent queue replay after reload');
    assert.equal(await run(`watchHistory.watchEntries()[0].nextPath`), 'Series/02.mp4');
    setClock(990); await wait(() => run('watchHistory.watchEntries()[0]?.completed===true'), 'completion');
    setClock(850, 1000, path.join(out, 'Other.mp4')); await new Promise(r => setTimeout(r, 2200));
    assert.equal(await run('watchHistory.watchEntries()[0].position'), 990);
    await run('watchHistory.clearWatchHistory()'); setClock(300); await new Promise(r => setTimeout(r, 2200));
    assert.equal(await run('watchHistory.watchEntries().length'), 0, 'live external player cannot resurrect cleared history');
    assert.equal(download.status, 'paused');
    player.close(); history.close(); await run('dispose()'); clearTimeout(deadline);
    console.log('PASS mpv history: actual Windows child process + private named pipe, fixed JSON properties, guarded history, backwards seek, unknown duration, track/episode preservation, persistent queue and renderer reload, completion, other-file rejection, clear; fixture: ' + out);
    app.exit(0);
  }).catch(error => { console.error(error); player?.close(); history?.close(); clearTimeout(deadline); app.exit(1); });
}
