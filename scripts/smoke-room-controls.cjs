// Real React controls in isolated Electron; fixture IPC only, no user's rooms.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-controls-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  const deadline = setTimeout(() => { console.error('Room controls smoke deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 760, height: 820, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    let detached;
    win.webContents.setWindowOpenHandler(({url,frameName}) => url === 'about:blank' && frameName === 'acceptance-controls'
      ? { action: 'allow', overrideBrowserWindowOptions: { show: false, width: 380, height: 500, webPreferences: { backgroundThrottling: false } } } : { action: 'deny' });
    win.webContents.on('did-create-window', child => { detached = child; child.webContents.setBackgroundThrottling(false); });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') {errors.push(details.message);console.error('Renderer:',details.message);} });
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/components/Modal.css',
      'renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css','renderer/components/VoiceSettingsModal.css',
      'renderer/pages/RoomsPage.css','renderer/pages/rooms/RoomServerPanel.css','renderer/pages/rooms/RoomLanPanel.css'].map(p => fs.readFileSync(path.join(root,p),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html = path.join(out, 'controls.html');
    fs.writeFileSync(html, `<html class="dark" lang="ru"><style>${css}\n#root{padding:16px;max-width:640px;margin:auto;height:740px;overflow:auto}body{overflow:auto}/* Stable snapshots: hidden child windows need not advance animation clocks. */*{transition:none!important;animation:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(e) {console.error('UI step:',code.slice(0,180));throw e;} };
    await run(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), ReactDOM=require(path.join(root,'node_modules/react-dom/client')), flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=k=>dict[k]||k, cache={}, notes=[];
      var toast=Object.assign(v=>notes.push(v),{success:v=>notes.push(v),error:v=>notes.push(v)});
      function load(p){
        if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.includes('hostToast'))return {useHostToast:()=>toast};
          if(s==='../../components')return Object.assign({},...['Avatar','Button','Icon','Select','Toggle','DropdownMenu'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      window.calls=[];window.failLoad=null;window.hold=false;window.finish=null;window.failSave=false;
      var data={config:{schema:[{key:'port',t:'int',min:1,max:65535,labelKey:'rooms.server.name',helpKey:'rooms.server.stopFirst'},
        {key:'online',t:'bool',labelKey:'rooms.server.cfg.whitelist'},{key:'mode',t:'select',labelKey:'rooms.server.name',options:[{value:'a',labelKey:'rooms.server.start'},{value:'b',labelKey:'rooms.server.stop'}]}],values:{port:'25565',online:'true',mode:'a'}},
        players:{whitelistEnabled:false,whitelist:[],banned:[],locked:false},
        content:{slots:[{slotId:'mods',labelKey:'rooms.server.content.intro',bound:true,folderId:'',readyCount:1,fileCount:1}],sync:'ok',pending:[{sha256:'abc',name:'Long optional server content.jar'}]},
        schedule:{enabled:false,rules:[{id:'one',days:[1,2],time:'18:00',action:'start',enabled:true}]},
        access:{operators:[]},backups:[]};
      var read=async key=>{calls.push(['read',key]);if(failLoad===key)throw Error('Test '+key+' load failure');return structuredClone(data[key]);};
      var mutate=async (...args)=>{calls.push(args);if(hold)await new Promise(r=>finish=r);if(failSave)throw Error('Test save failure');};
      window.api={rooms:{get:async()=>({members:[{memberId:'A',name:'Very long participant name in a narrow room window',online:true}]}),servers:{
        state:async()=>({instances:window.localFixture||[],modules:[],available:true}),onAlert:()=>()=>{},systemJava:async()=>({available:false}),console:async()=>[],watchConsole:async()=>{},onConsole:()=>()=>{},command:(...a)=>mutate('command',...a).then(()=>window.commandReply||{ok:true}),
        getConfig:async id=>{if(id==='slow')return await new Promise(r=>window.finishRead=r);return read('config')},saveConfig:async(id,v)=>{await mutate('saveConfig',id,v);data.config.values=v},
        players:()=>read('players'),savePlayers:async(id,p)=>{await mutate('savePlayers',id,p);Object.assign(data.players,p)},
        content:()=>read('content'),roomFolders:async()=>[],setContentFolder:(...a)=>mutate('bind',...a),clearContentFolder:(...a)=>mutate('unbind',...a),syncContent:async()=>{await mutate('sync');return data.content},consentContent:(...a)=>mutate('consent',...a),
        schedule:()=>read('schedule'),saveSchedule:async(id,r)=>{await mutate('saveSchedule',id,r);data.schedule.rules=r},setScheduleEnabled:(...a)=>mutate('arm',...a),
        access:()=>read('access'),grantOperator:(...a)=>mutate('grant',...a),revokeOperator:(...a)=>mutate('revoke',...a),backups:()=>read('backups'),
        createBackup:(...a)=>mutate('backup',...a),openBackupsFolder:async()=>{throw Error('Folder failed')},onUpdate:()=>()=>{}
      },voice:{devices:async()=>[],globalPtt:async()=>({available:true,supported:true}),micTestStart:async()=>{},micTestStop:async()=>{}}},
        onRoomUpdate:()=>()=>{},onVoiceDevicesChanged:()=>()=>{},onVoiceMicLevel:()=>()=>{}};
      var mounted=null;
      window.mount=(name,props={})=>{if(mounted)flush(()=>mounted.unmount());document.getElementById('root').replaceChildren();mounted=ReactDOM.createRoot(document.getElementById('root'));
        var dir=name==='VoiceSettingsModal'?'renderer/components/':'renderer/pages/rooms/';var C=load(path.join(root,dir+name+'.tsx'))[name];
        var child=React.createElement(C,{instanceId:'test',roomId:'room',locked:false,onClose:()=>{},...props});
        flush(()=>mounted.render(name==='AudioSettings'?React.createElement('div',{className:'room-sub-wrap',style:{height:32,width:'100%',position:'relative'}},child):child));};
      window.setInput=(sel,value)=>{var el=document.querySelector(sel);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      window.button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
      mount('ServerConfigForm');void 0;
    `);
    const wait = (ms=100) => new Promise(r=>setTimeout(r,ms));
    const until = async (code, label) => {
      const end = Date.now()+10000;
      while (!(await run(code))) {
        if (Date.now()>end) throw Error('UI timeout: '+label);
        await wait(50);
      }
    };
    const capture = async name => {win.webContents.invalidate();await wait(350);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    await wait();
    await until(`document.querySelectorAll('.number-input-controls').length===1`, 'initial settings');
    assert.equal(await run(`document.querySelectorAll('.number-input-controls').length`),1);
    await run(`document.querySelector('.number-input-controls button').click()`); await wait();
    assert.equal(await run(`document.querySelector('input[type=number]').value`),'25566');
    await run(`setInput('input[type=number]','70000')`);await wait();
    assert.equal(await run(`button('Сохранить').disabled`),true);
    await run(`setInput('input[type=number]','30000');hold=true`);await wait();
    await run(`button('Сохранить').click()`);await wait();
    assert.equal(await run(`document.querySelector('input[type=number]').disabled`),true);
    assert.equal(await run(`button('Сохранить').textContent.includes('Сохранить')`),true);
    assert.equal(await run(`button('Сохранить').getAttribute('aria-busy')`),'true');
    await run(`hold=false;finish()`);await wait();
    await capture('config-dark');
    await run(`mount('ServerConfigForm',{instanceId:'slow'})`);await wait();
    await run(`flush(()=>mounted.render(React.createElement(load(path.join(root,'renderer/pages/rooms/ServerConfigForm.tsx')).ServerConfigForm,{instanceId:'fast',locked:false})))`);await wait();
    await run(`finishRead({...data.config,values:{...data.config.values,port:'123'}})`);await wait();
    assert.equal(await run(`document.querySelector('input[type=number]').value`),'30000','stale instance response');
    await run(`failLoad='players';mount('ServerPlayersPanel')`);await wait();
    assert.equal(await run(`document.querySelector('[role=alert]').textContent.includes('load failure')`),true);
    await run(`failLoad=null;button('Повторить').click()`);await wait();
    await run(`setInput('.room-server-players-add input','Alex');failSave=true`);await wait();
    await run(`button('Добавить').click()`);await wait();
    assert.equal(await run(`document.querySelector('.room-server-players-add input').value`),'Alex');
    await run(`failSave=false;button('Добавить').click()`);await wait();
    assert.equal(await run(`document.querySelector('.room-server-players-add input').value`),'');
    await run(`mount('ServerContentPanel',{locked:true})`);await wait();
    assert.equal(await run(`button(t('rooms.server.content.consentAccept')).disabled`),true);
    await run(`mount('ServerContentPanel');hold=true`);await wait();
    await run(`document.querySelector('.custom-select-trigger').click()`);await wait();
    await run(`document.querySelectorAll('[role=option]')[0].click()`);await wait();
    assert.equal(await run(`document.querySelector('.custom-select-trigger').disabled`),true);
    await run(`hold=false;finish()`);await wait();
    await run(`mount('ServerSchedulePanel')`);await wait();
    // Mount data arrives asynchronously; make a real edit after it arrives.
    await run(`document.querySelectorAll('.room-server-schedule-day')[2].click();hold=true`);await wait();
    await run(`button(t('rooms.server.schedule.save')).click()`);await wait();
    assert.equal(await run(`document.querySelector('input[type=time]').disabled`),true,JSON.stringify(await run(`({calls,hold,buttons:[...document.querySelectorAll('button')].map(b=>[b.textContent,b.disabled]),rules:data.schedule.rules})`))); 
    assert.equal(await run(`[...document.querySelectorAll('.room-server-schedule-day')].every(b=>b.disabled)`),true);
    await run(`hold=false;finish()`);await wait();
    await run(`mount('ServerAccessPanel');hold=true`);await wait();
    await run(`document.querySelector('[role=switch]').click()`);await wait();
    assert.equal(await run(`document.querySelector('[role=switch]').disabled`),true);
    await run(`hold=false;finish()`);await wait();
    await run(`mount('ServerBackupPanel')`);await wait();
    await run(`button(t('rooms.server.backup.openFolder')).click()`);await wait();
    assert.equal(await run(`notes.some(n=>n.includes('Folder failed'))`),true);
    for(const key of ['config','content','schedule','access','backups']) {
      const name={config:'ServerConfigForm',content:'ServerContentPanel',schedule:'ServerSchedulePanel',access:'ServerAccessPanel',backups:'ServerBackupPanel'}[key];
      await run(`failLoad=${JSON.stringify(key)};mount(${JSON.stringify(name)})`);await wait();
      assert.equal(await run(`!!document.querySelector('[role=alert] button')`),true,key+' retry');
      await run(`failLoad=null;button('Повторить').click()`);await wait();
    }
    const theme=JSON.parse(fs.readFileSync(path.join(root,'themes/nihil-aero-midnight.havvn-theme.json'),'utf8'));
    await run(`for(var [k,v] of Object.entries(${JSON.stringify(theme.dark)}||{}))document.documentElement.style.setProperty(k,v);mount('VoiceSettingsModal')`);await wait();
    assert.equal(await run(`!!document.querySelector('.vsm-body')`),true);
    await capture('voice-aero');
    win.setSize(380,760);await wait();
    for(const name of ['VoiceSettingsModal','ServerConfigForm','ServerContentPanel','ServerAccessPanel','ServerSchedulePanel','ServerBackupPanel','ServerPlayersPanel']) {
      await run(`mount(${JSON.stringify(name)})`);await wait();
      assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`),true,name+' narrow overflow');
    }
    await capture('players-narrow');
    await run(`mount('AudioSettings',{prefs:load(path.join(root,'renderer/utils/audioPrefs.ts')).loadAudioPrefs(),onChange:()=>{},canEq:true,devices:[{deviceId:'speaker',label:'Long output device name in a narrow detached room player'}]})`);await wait();
    assert.equal(await run(`document.querySelectorAll('select').length`),0,'themeable audio output');
    assert.equal(await run(`document.querySelectorAll('[role=switch]').length`),4);
    assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`),true,'audio narrow overflow');
    await capture('audio-narrow');
    // Terminal LAN retry is available in the actual React panel, including failure/retry.
    await run("var LanPanel=load(path.join(root,'renderer/pages/rooms/RoomLanPanel.tsx')).RoomLanPanel;var lanFixture={available:true,active:true,isHost:true,sessionId:'test',selfVip:'10.1.0.1',participants:[{memberId:'B',vip:'10.1.0.2',status:'failed',terminal:true,failReason:'needs-turn'}]};window.retryCount=0;window.renderLan=()=>flush(()=>mounted.render(React.createElement(LanPanel,{roomId:'room',lan:lanFixture,members:[{memberId:'A',name:'Alice',isSelf:true},{memberId:'B',name:'Bob'}],selfId:'A',onStart:async()=>{},onStop:async()=>{},onRetry:async()=>{retryCount++;await new Promise(r=>finish=r);if(failSave)throw Error('Retry failed');}})));renderLan();");await wait();
    assert.equal(await run("button(t('rooms.lan.retry')).disabled"),false);
    await capture('lan-terminal-aero-narrow');
    await run("button(t('rooms.lan.retry')).click();button(t('rooms.lan.retry')).click()");await wait();
    assert.equal(await run('retryCount'),1);assert.equal(await run("button(t('rooms.lan.retry')).disabled"),true);
    await run('failSave=true;finish()');await wait();assert.equal(await run("button(t('rooms.lan.retry')).disabled"),false);
    await run("failSave=false;button(t('rooms.lan.retry')).click()");await wait();await run("finish();lanFixture={...lanFixture,participants:[{memberId:'B',vip:'10.1.0.2',status:'connecting'}]};renderLan()");await wait();
    assert.equal(await run("document.querySelector('.room-lan-fail')===null"),true);
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true);
    // Real console controls do not duplicate stdin requests while awaiting ACK.
    await run("document.documentElement.style.cssText='';mount('ServerConsole',{canSend:true,remote:true});hold=true;calls=[]");await wait();
    await run("setInput('.server-console-prompt input','list')");await wait();
    await run("document.querySelector('.server-console-send').click();document.querySelector('.server-console-send').click()");await wait();
    assert.equal(await run("calls.filter(c=>c[0]==='command').length"),1); assert.equal(await run("document.querySelector('.server-console-send').disabled"),true);
    await run("commandReply={ok:false,reason:'command-unknown'};hold=false;finish()");await wait();
    assert.equal(await run("document.querySelector('.server-console-command-status').textContent.includes('могла')"),true);
    await capture('console-unknown-outcome');
    // Leave choices use the actual themed Select, in the modal's own document.
    await run("mount('RoomServerLeaveOptions',{instances:[{instanceId:'test',name:'Test world',status:'running',scheduleEnabled:true}],mode:'stop',busy:false,onMode:value=>window.chosenMode=value})");await wait();
    await run("document.querySelector('.custom-select-trigger').click()");await wait();
    assert.equal(await run("document.querySelectorAll('[role=option]').length"),2);
    await run("document.querySelectorAll('[role=option]')[1].click()");await wait(); assert.equal(await run('chosenMode'),'local');
    await capture('leave-server-options');
    await run("mount('RoomServerLeaveOptions',{instances:null,mode:'stop',busy:false,onMode:()=>{}});document.querySelector('.custom-select-trigger').click()");await wait();
    assert.equal(await run("document.querySelectorAll('[role=option]').length"),1);
    await run("localFixture=[{instanceId:'test',moduleId:'generic',name:'Local fixture',version:'1',hostId:'self',isHost:true,role:'host',status:'running',since:Date.now(),port:25565,autoRestart:false,updatable:false,operators:[],local:true}];mount('RoomServerPanel',{roomId:'',showTitle:false})");await wait();
    await until("!!document.querySelector('.room-server-local-note')",'local management surface');
    assert.equal(await run("document.querySelector('.room-server-new')===null"),true);
    assert.equal(await run("document.querySelector('.room-server-local-note').textContent.includes('Локальный')"),true);
    assert.equal(await run("document.querySelector('[aria-label=\"'+t('rooms.server.contentAutoSync')+'\"]')===null"),true);
    await capture('local-server-overview');
    await run("document.documentElement.style.cssText='--radius-sm:12px;--radius-md:18px;--color-bg-primary:#112235;--color-bg-secondary:#19334b;--color-bg-tertiary:#294b69;--color-border:#628eac;--color-accent:#a6ddff;--color-text-primary:#e7f6ff;--color-text-secondary:#bbd3e6;'");win.setSize(380,820);await capture('local-server-aero-narrow');
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true);
    for (const mode of ['dark','light','aero']) {
      await run(`document.documentElement.style.cssText='';document.documentElement.dataset.theme=${JSON.stringify(mode==='light'?'light':'dark')};`);
      if (mode==='aero') await run(`for(var [k,v] of Object.entries(${JSON.stringify(theme.dark)}))document.documentElement.style.setProperty(k,v);void 0`);
      for (const name of ['VoiceSettingsModal','ServerConfigForm','ServerPlayersPanel','ServerContentPanel','ServerSchedulePanel','ServerAccessPanel','ServerBackupPanel']) {
        await run(`mount(${JSON.stringify(name)})`); await wait();
        assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,mode+'/'+name+' overflow');
      }
      await capture('panels-'+mode+'-narrow');
    }
    // The actual Select is also rendered into a different owning document.
    await run(`flush(()=>mounted.unmount());var frame=document.createElement('iframe');frame.style='width:330px;height:250px';document.getElementById('root').append(frame);var doc=frame.contentDocument;doc.body.innerHTML='<label for="foreign-select">Output device</label><div id="foreign-root"></div>';var style=doc.createElement('style');style.textContent=document.querySelector('style').textContent;doc.head.append(style);var foreign=ReactDOM.createRoot(doc.getElementById('foreign-root'));flush(()=>foreign.render(React.createElement(load(path.join(root,'renderer/components/Select.tsx')).Select,{id:'foreign-select',ariaLabel:'Output device',value:'a',options:[{value:'a',label:'First'},{value:'b',label:'Second'}],onChange:()=>{}})));doc.querySelector('label').click();`);
    assert.equal(await run(`doc.activeElement.id`),'foreign-select');
    await run(`doc.activeElement.dispatchEvent(new frame.contentWindow.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`);await wait();
    assert.equal(await run(`doc.querySelector('.custom-select-dropdown').matches(':popover-open')`),true);
    await run(`doc.activeElement.dispatchEvent(new frame.contentWindow.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);await wait();
    assert.equal(await run(`doc.querySelector('.custom-select-dropdown')===null`),true);
    await run(`foreign.unmount();document.getElementById('root').innerHTML='<div id="detached-harness"></div>';var portalView=ReactDOM.createRoot(document.getElementById('detached-harness'));
      function DetachedHarness(){var dock=load(path.join(root,'renderer/utils/popout.ts')).usePopout('acceptance-controls','Acceptance controls');window.dock=dock;var [value,setValue]=React.useState('a');window.detachedValue=value;
        var control=React.createElement(load(path.join(root,'renderer/components/Select.tsx')).Select,{id:'detached-select',value,options:[{value:'a',label:'First'},{value:'b',label:'Second'}],onChange:setValue});return dock.portal(control)||control;}
      flush(()=>portalView.render(React.createElement(DetachedHarness)));void 0`);await wait();
    await run('dock.openPopout();void 0');await until('!!dock.popout?.document.querySelector("#detached-select")','actual popout');
    assert.ok(detached && detached!==win);
    await run(`dock.popout.document.querySelector('#detached-select').focus();dock.popout.document.querySelector('#detached-select').dispatchEvent(new dock.popout.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));void 0`);await wait();
    assert.equal(await run(`dock.popout.document.querySelector('.custom-select-dropdown').matches(':popover-open')`),true);
    assert.equal(await run(`document.querySelector('.custom-select-dropdown')===null`),true,'popover stays in child');
    await run(`dock.popout.document.activeElement.dispatchEvent(new dock.popout.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));dock.popout.document.activeElement.dispatchEvent(new dock.popout.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));void 0`);await wait();
    assert.equal(await run('detachedValue'),'b');
    await run(`document.documentElement.style.cssText='--radius-md:23px';document.documentElement.dataset.reduceMotion='true';document.documentElement.dataset.theme='light';void 0`);await wait();
    assert.equal(await run(`dock.popout.document.documentElement.dataset.theme`),'light');
    assert.equal(await run(`dock.popout.getComputedStyle(dock.popout.document.documentElement).getPropertyValue('--radius-md').trim()`),'23px');
    detached.setContentSize(380,500);await wait(300);
    assert.equal(await run("dock.popout.getComputedStyle(dock.popout.document.body).backgroundColor"),'rgb(246, 244, 240)');
    assert.equal(await run("dock.popout.getComputedStyle(dock.popout.document.querySelector('.custom-select-trigger')).backgroundColor"),'rgb(238, 235, 229)');
    const childImage=await detached.webContents.capturePage(undefined,{stayHidden:false,stayAwake:true});
    assert.equal(childImage.isEmpty(),false,'native child screenshot must contain a painted frame');
    fs.writeFileSync(path.join(out,'actual-popout-light.png'),childImage.toPNG());
    const closed=new Promise(resolve=>detached.once('closed',resolve));
    await run('portalView.unmount();void 0');
    await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Native child did not close after unmount')),5000))]);
    assert.equal(detached.isDestroyed(),true,'unmount closes native child');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify({actualReactControls:true,darkLightAero:true,narrowPanels:true,repeatedActions:true,staleRepliesIgnored:true,actualNativePopout:true,keyboardSelectionInChild:true,themeMirrorsLive:true,unmountClosesChild:true},null,2));
    console.log('Room controls smoke passed. Screenshots: '+out);
    clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
