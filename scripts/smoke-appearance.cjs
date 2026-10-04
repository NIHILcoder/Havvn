// Native Acrylic and real React controls; an isolated, synthetic local profile.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-appearance-'));
  app.setPath('userData', path.join(out, 'profile'));
  const deadline = setTimeout(() => { console.error('Appearance test deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const { WindowMaterial } = require(path.join(root, 'dist/electron/electron/utils/window-material.js'));
    const { supportsAcrylic } = require(path.join(root, 'dist/electron/shared/appearance.js'));
    const supported = supportsAcrylic(process.platform, os.release()), material = new WindowMaterial(supported);
    const win = new BrowserWindow({ show: false, frame: false, width: 1100, height: 920,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    material.register(win);
    ipcMain.handle('fixture:acrylic:get', () => material.status());
    ipcMain.handle('fixture:acrylic:set', (_event, enabled) => { assert.equal(typeof enabled, 'boolean');
      fs.writeFileSync(path.join(out, 'native.json'), JSON.stringify({ enabled })); return material.setEnabled(enabled); });
    win.webContents.setWindowOpenHandler(({ url, frameName }) => url === 'about:blank' && frameName === 'appearance-fixture'
      ? { action: 'allow', overrideBrowserWindowOptions: { show: false, frame: false, width: 430, height: 600, webPreferences: { backgroundThrottling: false } } } : { action: 'deny' });
    let detached;
    win.webContents.on('did-create-window', child => { detached = child; material.register(child); });
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css',
      'renderer/styles/appearance.css','renderer/components/Modal.css','renderer/components/Select.css','renderer/components/Toggle.css',
      'renderer/pages/settings/controls.css','renderer/pages/settings/shell.css','renderer/components/GlassControls.css','renderer/components/ThemeEditor.css']
      .map(p => fs.readFileSync(path.join(root,p),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html = path.join(out, 'appearance.html');
    fs.writeFileSync(html, `<html data-theme=dark><style>${css}\n*{animation:none!important;transition:none!important}.fixture-main{padding:18px;overflow:auto}.sidebar{padding:24px}.stg-main{min-height:0}.popout-root{overflow:auto!important;padding:16px}@media(max-width:600px){.sidebar{display:none}.fixture-main{padding:12px}}</style><div id=root></div></html>`);
    await win.loadFile(html);
    const errors=[]; win.webContents.on('console-message', details => { if(details.level==='error') { errors.push(details.message); console.error('Renderer:',details.message); } });
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(error) { console.error('Failed UI step:',code.slice(0,200)); throw error; } };
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client')),flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=k=>dict[k]||k,cache={};
      function load(p){if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s==='../../../components'||s==='../../components')return Object.assign({},...['Button','Icon','Select','Toggle'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;}
      var ipc=require('electron').ipcRenderer;window.api={appearance:{getAcrylic:()=>ipc.invoke('fixture:acrylic:get'),setAcrylic:v=>ipc.invoke('fixture:acrylic:set',v),onAcrylicChanged:()=>()=>{}}};
      var appearance=load(path.join(root,'renderer/utils/appearance.ts')),shared=load(path.join(root,'shared/appearance.ts'));
      var stop=appearance.bootAppearance(),Panel=load(path.join(root,'renderer/pages/settings/sections/AppearancePanel.tsx')).AppearancePanel;
      var ThemeContext=load(path.join(root,'renderer/components/ThemeEditorContext.tsx')),Glass=load(path.join(root,'renderer/components/GlassControls.tsx')).GlassControls;
      function GlassFixture(){var [prefs,setPrefs]=React.useState(appearance.readAppearance);React.useEffect(()=>{var sync=()=>setPrefs(appearance.readAppearance());window.addEventListener(appearance.APPEARANCE_EVENT,sync);return()=>window.removeEventListener(appearance.APPEARANCE_EVENT,sync);},[]);return React.createElement(Glass,{value:shared.getThemeGlass(prefs),onChange:glass=>appearance.saveAppearance({...appearance.readAppearance(),...glass})});}
      var mounted=ReactDOM.createRoot(document.getElementById('root')),popout;
      function View(){popout=load(path.join(root,'renderer/utils/popout.ts')).usePopout('appearance-fixture','Havvn glass');return React.createElement('div',{className:'app-shell'},
        React.createElement('div',{className:'titlebar'},'Havvn'),React.createElement('div',{className:'app-container'},
        React.createElement('aside',{className:'sidebar'},'Havvn — test navigation'),React.createElement('main',{className:'main-content fixture-main stg-main'},React.createElement(ThemeContext.ThemeEditorProvider,null,React.createElement(GlassFixture),React.createElement(Panel,{onProfileApplied:()=>{}})))),
        popout.portal(React.createElement('section',{className:'stg-card'},React.createElement('div',{className:'stg-card-b'},'Detached glass'))));}
      flush(()=>mounted.render(React.createElement(View)));
      window.button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      window.switchFor=key=>document.querySelector('[aria-label='+JSON.stringify(t(key))+']');
      window.setInput=(selector,value)=>{var el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      true;
    `);
    const wait = () => new Promise(resolve => setTimeout(resolve, 180)); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'solid');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),background:'aurora'})`); await wait();
    await run(`button(t('appearance.preset.liquid')).click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'liquid');
    assert.equal(await run(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter.includes('blur')`),true);
    assert.equal(await run(`getComputedStyle(document.querySelector('.ap-preview-surface')).backgroundImage.includes('radial-gradient')`),true);
    await run(`var surface=document.querySelector('.ap-preview-surface'),bounds=surface.getBoundingClientRect();surface.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:bounds.left+20,clientY:bounds.top+20}));true;`);
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); await wait();
    assert.equal(await run(`!!document.querySelector('.ap-preview-surface').style.getPropertyValue('--ap-x')`),true);
    await run(`document.documentElement.dataset.reduceMotion='true'`); await wait();
    assert.equal(await run(`document.querySelector('.ap-preview-surface').style.getPropertyValue('--ap-x')`),'');
    await run(`delete document.documentElement.dataset.reduceMotion`);
    await run(`switchFor('appearance.acrylic').click()`); await wait();
    assert.equal(material.status().enabled,true); assert.equal(material.status().active,supported);
    assert.equal(await run(`document.documentElement.dataset.acrylic`),supported?'active':'off');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,'native.json'))).enabled,true);
    // Snapshots use synthetic gradients only, never the native desktop backdrop.
    await run(`switchFor('appearance.acrylic').click()`); await wait();
    await run(`document.querySelectorAll('.ap-advanced')[0].open=true;switchFor('appearance.scope.sidebar').click()`); await wait();
    assert.equal(await run(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter`),'none');
    await run(`switchFor('appearance.scope.sidebar').click();appearance.saveAppearance({...appearance.readAppearance(),radii:{panels:16,cards:18,buttons:10,inputs:12}})`); await wait();
    assert.equal(await run(`getComputedStyle(document.querySelector('.stg-card')).borderRadius`),'18px');
    await run(`document.documentElement.style.setProperty('--radius-scale','14px');appearance.saveAppearance({...appearance.readAppearance(),radii:{panels:null,cards:null,buttons:null,inputs:null}})`); await wait();
    assert.equal(await run(`getComputedStyle(document.querySelector('.stg-card')).borderRadius`),'14px');
    await run(`document.querySelectorAll('.ap-advanced')[1].open=true;setInput('.ap-advanced input[type=text]','Fixture Aero')`); await wait();
    await run(`button(t('appearance.saveProfile')).click()`); await wait();
    assert.equal(await run(`load(path.join(root,'renderer/utils/appearance-profiles.ts')).loadAppearanceProfiles()[0].name`),'Fixture Aero');
    // Exercise real download/export and file input/import, including invalid JSON.
    const exported = new Promise((resolve,reject) => {
      win.webContents.session.once('will-download', (_event,item) => {
        const destination=path.join(out,'export.appearance.json'); item.setSavePath(destination);
        item.once('done',(_event,state)=>state==='completed'?resolve(destination):reject(Error(state)));
      });
    });
    await run(`button(t('appearance.export')).click()`);
    const exportedPath = await exported;
    const profile=JSON.parse(fs.readFileSync(exportedPath,'utf8')); assert.equal(profile.name,'Fixture Aero');
    await run(`var imported=${JSON.stringify({...profile,name:'Imported look'})};var input=document.querySelector('.ap-advanced input[type=file]'),transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(imported)],'profile.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));true;`); await wait();
    assert.equal(await run(`load(path.join(root,'renderer/utils/appearance-profiles.ts')).loadAppearanceProfiles().length`),2);
    await run(`var transfer=new DataTransfer();transfer.items.add(new File(['invalid'],'bad.json',{type:'application/json'}));var input=document.querySelector('.ap-advanced input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));true;`); await wait();
    assert.equal(await run(`document.querySelector('[role=alert]').textContent`),await run(`t('appearance.profileError')`));
    await run(`var canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillRect(0,0,64,64);new Promise(resolve=>canvas.toBlob(blob=>{var transfer=new DataTransfer();transfer.items.add(new File([blob],'wallpaper.png',{type:'image/png'}));var input=document.querySelector('.ap-actions input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));resolve();},'image/png'));`); await wait();
    assert.equal(await run(`appearance.readAppearance().background`),'image');
    assert.equal(await run(`appearance.readAppearance().wallpaper.startsWith('data:image/png;base64,')`),true);
    assert.equal(await run(`JSON.parse(localStorage.getItem('havvn.appearance.v1')).wallpaper`),'','sliders must not rewrite the image');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),blur:17})`); await wait();
    assert.equal(await run(`appearance.readAppearance().wallpaper.startsWith('data:image/png;base64,')`),true);
    await run(`button(t('appearance.removeImage')).click()`); await wait();
    assert.equal(await run(`appearance.readAppearance().wallpaper`),'');
    assert.equal(await run(`localStorage.getItem('havvn.appearance.wallpaper.v1')`),null);
    await run(`load(path.join(root,'renderer/utils/appearance-profiles.ts')).applyAppearanceProfile(load(path.join(root,'renderer/utils/appearance-profiles.ts')).loadAppearanceProfiles()[0])`); await wait();
    assert.equal(await run(`appearance.readAppearance().background`),'aurora');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),intensity:0})`); await wait();
    assert.equal(await run(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter`),'none');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),intensity:70})`); await wait();
    await run(`appearance.saveAppearance({...appearance.readAppearance(),quality:'light'})`); await wait();
    assert.equal(await run(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter.includes('blur(8px)')`),true);
    await run(`appearance.saveAppearance({...appearance.readAppearance(),quality:'full'});document.querySelectorAll('.ap-advanced')[0].open=false;document.querySelectorAll('.ap-advanced')[1].open=false;document.querySelector('.fixture-main').scrollTop=0`); await wait();
    const capture=async name=>{await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await wait();const image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});assert.equal(image.isEmpty(),false);fs.writeFileSync(path.join(out,name+'.png'),image.toPNG());};
    await capture('liquid-dark');
    const theme=JSON.parse(fs.readFileSync(path.join(root,'themes/nihil-aero-midnight.havvn-theme.json'),'utf8'));
    await run(`load(path.join(root,'renderer/utils/theme-library.ts')).applyThemeObject(${JSON.stringify(theme)});button(t('appearance.preset.aero')).click()`); await wait();
    await capture('aero');
    await run(`localStorage.setItem('theme','light');load(path.join(root,'renderer/utils/theme-library.ts')).deactivateTheme()`); await wait(); await capture('liquid-light');
    await run(`popout.openPopout()`); await wait(); assert.ok(detached);
    assert.equal(await detached.webContents.executeJavaScript(`document.documentElement.dataset.material`),'liquid');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),material:'frosted',radii:{panels:null,cards:20,buttons:null,inputs:null}})`); await wait();
    assert.equal(await detached.webContents.executeJavaScript(`document.documentElement.dataset.material`),'frosted');
    assert.equal(await detached.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.stg-card')).borderRadius`),'20px');
    await run(`popout.closePopout()`); await wait(); win.setSize(380,920); await wait();
    assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`),true,'narrow viewport overflow'); await capture('glass-narrow');
    win.setSize(1100,920); await wait();
    await run(`
      var library=load(path.join(root,'renderer/utils/theme-library.ts')),profiles=load(path.join(root,'renderer/utils/appearance-profiles.ts'));
      library.deactivateTheme();library.saveLibrary([]);localStorage.setItem('theme','dark');
      appearance.saveAppearance({...structuredClone(shared.DEFAULT_APPEARANCE),background:'sunset'});
      var Editor=load(path.join(root,'renderer/components/ThemeEditor.tsx')).ThemeEditor;
      var exportedTheme,importedTheme;
      window.api.themes={export:async(theme)=>{exportedTheme=JSON.parse(JSON.stringify(theme));return {success:true};},import:async()=>({success:true,data:importedTheme})};
      function ActualView(){var ctx=ThemeContext.useThemeEditor();return React.createElement('div',{className:'app-container'},React.createElement('aside',{className:'sidebar'},'Navigation'),
        React.createElement('main',{className:'main-content fixture-main stg-main'},React.createElement(Panel,{onProfileApplied:()=>{},profilesLocked:ctx.open})),
        ctx.open?React.createElement(Editor,{onClose:ctx.closeEditor,initialTab:ctx.initialTab}):null);}
      flush(()=>mounted.render(React.createElement(ThemeContext.ThemeEditorProvider,null,React.createElement(ActualView))));true;
    `); await wait();
    assert.equal(await run(`!!button(t('appearance.preset.liquid'))`),false,'glass controls must leave Settings');
    await run(`button(t('appearance.editGlass')).click()`); await wait();
    assert.equal(await run(`document.querySelector('[role=tab][aria-selected=true]').textContent.trim()`),await run(`t('appearance.glassTab')`));
    await run(`button(t('appearance.preset.liquid')).click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'liquid');
    assert.equal(await run(`appearance.readAppearance().material`),'solid','preview cannot persist window settings');
    assert.equal(await run(`appearance.readAppearance().background`),'sunset','presets cannot change the window backdrop');
    await run(`document.querySelector('[aria-label='+JSON.stringify(t('settings.theme.undo'))+']').click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'solid');
    await run(`document.querySelector('[aria-label='+JSON.stringify(t('settings.theme.redo'))+']').click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'liquid');
    await run(`document.querySelector('.ted [aria-label='+JSON.stringify(t('common.close'))+']').click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'solid','cancel restores the active material');
    await run(`button(t('appearance.editGlass')).click()`); await wait();
    await run(`button(t('appearance.preset.aero')).click();setInput('.ted-glass input[type=text]','Theme Aero')`); await wait();
    await run(`button(t('settings.theme.save')).click()`); await wait();
    assert.equal(await run(`library.getActiveTheme().glass.material`),'liquid');
    assert.equal(await run(`library.getActiveTheme().name`),'Theme Aero');
    await run(`button(t('settings.theme.export')).click()`); await wait();
    assert.equal(await run(`JSON.stringify(exportedTheme.glass)===JSON.stringify(library.getActiveTheme().glass)`),true);
    assert.equal(await run(`'acrylic' in exportedTheme.glass || 'wallpaper' in exportedTheme.glass`),false);
    await capture('theme-editor-glass');
    await run(`button(t('appearance.preset.minimal')).click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'solid');
    await run(`document.querySelector('.ted [aria-label='+JSON.stringify(t('common.close'))+']').click()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'liquid','cancel restores SAVED glass');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),backgroundDim:42});library.bootApplyActiveTheme()`); await wait();
    assert.equal(await run(`document.documentElement.dataset.material`),'liquid','window changes and boot preserve active theme glass');
    assert.equal(await run(`profiles.captureAppearanceProfile('Glass profile').appearance.material`),'liquid');
    await run(`button(t('appearance.editGlass')).click()`); await wait();
    await run(`importedTheme={...exportedTheme,name:'Imported Glass'};button(t('settings.theme.import')).click()`); await wait();
    assert.equal(await run(`library.loadLibrary().find(t=>t.name==='Imported Glass').glass.material`),'liquid');
    await run(`button(t('appearance.glassTab')).click()`); await wait();
    win.setSize(380,920); await wait();
    assert.equal(await run(`document.querySelector('.ted').scrollWidth<=document.querySelector('.ted').clientWidth`),true,'glass editor must fit narrow dock');
    assert.equal(await run(`var r=document.querySelector('.ted').getBoundingClientRect();r.left>=0&&r.right<=innerWidth`),true,'dock must stay inside the viewport after resize');
    await capture('theme-editor-glass-narrow');
    await run(`document.querySelector('.ted [aria-label='+JSON.stringify(t('common.close'))+']').click()`); await wait();
    await run(`var solid={id:'solid',name:'Solid',dark:{},light:{},glass:shared.getThemeGlass(shared.DEFAULT_APPEARANCE)};library.saveLibrary([...library.loadLibrary(),solid]);library.activateTheme(solid)`);
    assert.equal(await run(`document.documentElement.dataset.material`),'solid','switching themes changes glass');
    await run(`stop();flush(()=>mounted.unmount())`); assert.deepEqual(errors,[]); win.destroy(); clearTimeout(deadline);
    console.log(JSON.stringify({passed:true,nativeSupported:supported,checks:['native enable/disable','palette inheritance','scope controls','radii override/reset',
      'profile export/import/apply','invalid file errors','wallpaper import/removal','motion settings','quality','dark/light/Aero screenshots','real detached window mirroring','380px layout','theme editor shortcut and relocation','theme glass undo/redo/cancel','theme save/export/import','theme switch and boot','native/background isolation'],output:out})); app.quit();
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
