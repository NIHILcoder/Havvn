// Isolated checks of the real React dialog with fixture IPC, without user data.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-controls-'));
  app.setPath('userData', path.join(out, 'profile'));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Controls smoke deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer:', details.message); });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/Modal.css', 'renderer/components/Toggle.css', 'renderer/components/NumberInput.css', 'renderer/components/ContextMenu.css', 'renderer/components/TorrentControlModal.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const preview = path.join(out, 'controls.html');
    fs.writeFileSync(preview, `<html lang="ru"><style>${css}</style><div id="root"></div></html>`);
    await win.loadFile(preview);
    await win.webContents.executeJavaScript(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path');
      var ts=require(path.join(root,'node_modules/typescript')), React=require(path.join(root,'node_modules/react'));
      var ReactDOM=require(path.join(root,'node_modules/react-dom/client')), flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var locale='ru', dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), cache={};
      var translate=k=>dict[k]||k;
      window.calls=[];window.alerts=[];window.fail=null;window.failTime=false;window.pending=null;window.replies={};window.closed=0;window.updates=0;
      window.fileList=[{name:'A long video filename in a torrent with spaces and Cyrillic — серия 01.mkv',path:'Series/episode01.mkv',length:1024**3,priority:'normal'},{name:'Very long optional document.txt',path:'document.txt',length:1024,priority:'skip'}];
      window.trackerList=[{url:'https://tracker.example.org/a-very-long-path/announce',status:'connected',peers:8,lastAnnounce:Date.now()}];
      var read=async kind=>{calls.push(['read',kind]);if(fail===kind)throw Error('Test '+kind+' failure');if(replies[kind])return await new Promise(resolve=>{pending=resolve});return kind==='files'?structuredClone(fileList):kind==='trackers'?structuredClone(trackerList):kind==='peers'?[{address:'192.0.2.1:6881',client:'A long client name',country:'DE',connType:'tcp-out',progress:.5,downSpeed:1000000,upSpeed:10000,flagStr:'DU'}]:{pieceCount:100,haveCount:25,buckets:[1,0,.5]};};
      window.api={historyPlayback:{files:()=>read('files')},getTrackers:()=>read('trackers'),getPeers:()=>read('peers'),getPieces:()=>read('pieces'),
        setSequentialDownload:async(id,value)=>{calls.push(['sequential',id,value])},
        setSeedRatioLimit:async(id,value)=>{calls.push(['ratio',id,value])},
        setSeedTimeLimit:async(id,value)=>{calls.push(['time',id,value]);if(failTime){failTime=false;throw Error('Time limit failed')}},
        setFilePriority:async(id,index,value)=>{calls.push(['priority',id,index,value]);fileList[index].priority=value;},
        addTracker:async(id,url)=>{calls.push(['addTracker',id,url]);trackerList.push({url,status:'updating',peers:0});},
        removeTracker:async(id,url)=>{calls.push(['removeTracker',id,url]);trackerList=trackerList.filter(t=>t.url!==url);},
        reannounceDownload:async id=>{calls.push(['announce',id])},
        selectDirectory:async()=>null,setDownloadLocation:async()=>{throw Error('Should not move after cancel')},banPeer:async()=>{}};
      function load(p){
        if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const src=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',src)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t:translate,language:locale})};
          if(s.includes('ConfirmDialog'))return {useConfirm:()=>({alert:async v=>{alerts.push(v)},confirm:async()=>true})};
          if(s.includes('ExternalPlayerModal'))return {ExternalPlayerModal:()=>null};
          if(s==='./index')return {Button:load(path.join(root,'renderer/components/Button.tsx')).Button,Icon:load(path.join(root,'renderer/components/Icon.tsx')).Icon,Toggle:load(path.join(root,'renderer/components/Toggle.tsx')).Toggle};
          if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      window.mount=(overrides={})=>{window.controlRoot=ReactDOM.createRoot(document.getElementById('root'));flush(()=>controlRoot.render(React.createElement(load(path.join(root,'renderer/components/TorrentControlModal.tsx')).default,{download:{id:'fixture',name:'Very long torrent name — фильм с кириллицей и пробелами',savePath:'D:/Downloads/Folder with a very long name',...overrides},onClose:()=>{closed++},onUpdate:()=>{updates++}})));};
      window.switchTab=id=>document.getElementById('tcm-tab-'+id).click();
      window.setNumber=(index,value)=>{const input=document.querySelectorAll('.tcm-input')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
      mount();void 0;
    `);
    const run = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { console.error('Failed UI step:', code); throw error; }
    };
    const wait = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
    const capture = name => win.webContents.capturePage().then(img => fs.writeFileSync(path.join(out, name + '.png'), img.toPNG()));
    await wait();
    assert.equal(await run(`document.querySelector('.tcm-actions button').disabled`), true);
    await run(`document.querySelector('[role=switch]').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))`); await wait();
    assert.equal(await run(`document.querySelector('[role=switch]').getAttribute('aria-checked')`), 'true');
    await run(`document.querySelector('.tcm-actions button').click()`); await wait();
    assert.deepEqual(await run(`calls.filter(c=>c[0]==='sequential')`), [['sequential', 'fixture', true]]);
    assert.equal(await run(`document.querySelector('.tcm-saved').textContent`), 'Изменения применены');
    await run(`document.querySelector('.tcm-field .btn').click()`); await wait();
    assert.equal(await run(`alerts.length`), 0);
    await run(`switchTab('seeding')`); await wait();
    assert.equal(await run(`document.querySelectorAll('.number-input-controls').length`), 2);
    assert.equal(await run(`[...document.querySelectorAll('.tcm-input')].every(input=>input.value===''&&input.placeholder==='Общий')`), true);
    assert.equal(await run(`document.querySelector('.tcm-error')===null`), true);
    assert.equal(await run(`document.querySelector('.tcm-actions button').disabled`), true);
    await run(`setNumber(0,'1.5')`); await wait();
    await run(`document.querySelector('.tcm-actions button').click()`); await wait();
    assert.deepEqual(await run(`calls.filter(c=>c[0]==='ratio')`), [['ratio', 'fixture', 1.5]]);
    assert.equal(await run(`calls.some(c=>c[0]==='time')`), false);
    await run(`setNumber(1,'30')`); await wait();
    await run(`setNumber(1,'')`); await wait();
    assert.equal(await run(`document.querySelector('.tcm-actions button').disabled`), true);
    await run(`setNumber(1,'2.5')`); await wait();
    assert.equal(await run(`document.querySelector('.tcm-actions button').disabled`), true);
    await run(`setNumber(0,'3');setNumber(1,'10');failTime=true;`); await wait();
    await run(`document.querySelector('.tcm-actions button').click()`); await wait();
    assert.equal(await run(`alerts.length`), 1);
    await run(`document.querySelector('.tcm-actions button').click()`); await wait();
    assert.equal(await run(`calls.filter(c=>c[0]==='ratio'&&c[2]===3).length`), 1);
    assert.equal(await run(`calls.filter(c=>c[0]==='time'&&c[2]===10).length`), 2);
    await run(`setNumber(0,'0')`); await wait();
    await run(`document.querySelector('.tcm-actions button').click()`); await wait();
    assert.equal(await run(`calls.filter(c=>c[0]==='ratio').at(-1)[2]`), 0);
    await run(`document.querySelector('.number-input-controls button').click()`); await wait();
    assert.equal(await run(`document.querySelector('.tcm-input').value`), '0.1');
    for (const width of [1000, 620, 400]) {
      win.setContentSize(width, 760);
      for (const theme of ['dark', 'light', 'aero']) {
        await run(`load(path.join(root,'shared/theme.ts')).clearAppliedTheme(document.documentElement);document.documentElement.setAttribute('data-theme',${JSON.stringify(theme === 'light' ? 'light' : 'dark')});
          if(${JSON.stringify(theme)}==='aero'){const p=path.join(root,'themes/nihil-frutiger-aero.havvn-theme.json');if(fs.existsSync(p))load(path.join(root,'shared/theme.ts')).applyTheme(document.documentElement,JSON.parse(fs.readFileSync(p,'utf8')),'dark');}`);
        for (const tab of ['download', 'seeding', 'files', 'peers', 'pieces', 'trackers']) {
          await run(`switchTab(${JSON.stringify(tab)})`); await wait();
          assert.equal(await run(`document.querySelector('.um-card').scrollWidth>document.querySelector('.um-card').clientWidth`), false, `${width}/${theme}/${tab} card overflow`);
          assert.equal(await run(`document.querySelector('.tcm-body').scrollWidth>document.querySelector('.tcm-body').clientWidth`), false, `${width}/${theme}/${tab} body overflow`);
          assert.equal(await run(`document.querySelector('.tcm-tabs').scrollWidth>document.querySelector('.tcm-tabs').clientWidth`), false);
          if (tab === 'peers') {
            assert.equal(await run(`document.querySelector('.tcm-peers-head .pc-cc').textContent`), 'Страна');
            assert.equal(await run(`(()=>{const a=document.querySelector('.tcm-peers-head .pc-cc').getBoundingClientRect(),b=document.querySelector('.tcm-peers-head .pc-addr').getBoundingClientRect();return a.right<=b.left})()`), true);
          }
          await capture(`${width}-${theme}-${tab}`);
        }
      }
    }
    await run(`switchTab('files')`); await wait();
    await run(`document.querySelectorAll('.tcm-file-row')[0].querySelectorAll('.tcm-priority-btn')[3].click()`); await wait();
    assert.equal(await run(`document.querySelector('.tcm-priority-btn[aria-pressed=true]').textContent`), 'Высокий');
    for (const kind of ['files', 'trackers', 'peers', 'pieces']) {
      await run(`switchTab('download');fail=${JSON.stringify(kind)}`); await wait();
      await run(`switchTab(${JSON.stringify(kind)})`); await wait();
      assert.ok((await run(`document.querySelector('.tcm-error').textContent`)).includes('failure'));
      await run(`fail=null;document.querySelector('.tcm-error button').click()`); await wait();
      assert.equal(await run(`document.querySelector('.tcm-error')===null`), true);
    }
    await run(`switchTab('trackers');`); await wait();
    await run(`{const input=document.querySelector('.tcm-tracker-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'udp://tracker.example.net:6969/announce');input.dispatchEvent(new Event('input',{bubbles:true}));}`); await wait();
    await run(`{const input=document.querySelector('.tcm-tracker-input');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}`); await wait();
    assert.equal(await run(`calls.filter(c=>c[0]==='addTracker').length`), 1);
    await run(`document.querySelector('.tcm-tracker-row button').click()`); await wait();
    assert.equal(await run(`calls.filter(c=>c[0]==='removeTracker').length`), 1);
    await run(`switchTab('download');replies.peers=true;`); await wait();
    await run(`switchTab('peers')`); await wait(1800);
    const before = await run(`calls.filter(c=>c[0]==='read'&&c[1]==='peers').length`);
    await wait(1600);
    assert.equal(await run(`calls.filter(c=>c[0]==='read'&&c[1]==='peers').length`), before);
    await run(`switchTab('download');pending([{address:'stale-peer'}]);replies.peers=false;`); await wait();
    assert.equal(await run(`document.querySelector('.pc-addr')===null`), true);
    await run(`locale='en';dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/en.json'),'utf8'));switchTab('seeding');`); await wait();
    assert.equal(await run(`document.querySelector('#tcm-tab-seeding').getAttribute('aria-selected')`), 'true');
    await capture('400-aero-english');
    await run(`document.querySelector('#tcm-tab-seeding').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`); await wait();
    assert.equal(await run(`document.activeElement.id`), 'tcm-tab-trackers');
    await run(`flush(()=>controlRoot.unmount());`); await wait();
    const total = await run(`calls.length`);
    await wait(2700);
    assert.equal(await run(`calls.length`), total);
    await run(`mount({seedRatioLimit:2,seedTimeLimitMinutes:30});switchTab('seeding');`); await wait();
    assert.equal(await run(`document.querySelectorAll('.tcm-input')[0].value`), '2');
    assert.equal(await run(`document.querySelectorAll('.tcm-input')[1].value`), '30');
    assert.equal(await run(`document.querySelector('.tcm-actions button').disabled`), true);
    await run(`setNumber(1,'15')`); await wait();
    const ratioCalls = await run(`calls.filter(c=>c[0]==='ratio').length`);
    await run(`document.querySelector('.tcm-actions button').click()`); await wait();
    assert.equal(await run(`calls.filter(c=>c[0]==='ratio').length`), ratioCalls);
    await run(`flush(()=>controlRoot.unmount())`);
    console.log('Torrent controls passed: six tabs, 1000/620/400 px, dark/light/Aero, numeric validation, untouched limits, partial save retry, priorities, tracker double-submit, errors/retry, polling and keyboard. Screenshots:', out);
    clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
