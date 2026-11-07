// Real React profile buttons, offline scene loading and persistence in an isolated window.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..');
  const out = fs.mkdtempSync(path.join(root, 'dist', 'appearance-collection-'));
  app.setPath('userData', path.join(out, 'profile'));
  const deadline = setTimeout(() => { console.error('Collection test deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1220, height: 1300,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/styles/appearance-scenes.css',
      'renderer/pages/settings/controls.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css',
      'renderer/components/GlassControls.css', 'renderer/components/AppearanceCollection.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')
        .replace(/url\("(\.\.\/assets\/scenes\/[^\"]+)"\)/g, (_, relative) =>
          `url("${pathToFileURL(path.resolve(root, 'renderer/styles', relative)).href}")`)).join('\n');
    fs.writeFileSync(path.join(out, 'fixture.html'), `<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>${css}
      * { animation:none!important; transition:none!important; }
      body { display:block; margin:0; overflow:auto; } main { max-width:1120px; padding:32px; margin:auto; }
      main.main-content { overflow:visible; }
      h1 { font:600 26px/1.3 system-ui; margin:0 0 10px; } p { color:var(--color-text-secondary); margin:0 0 24px; }
      .ap-collection { grid-template-columns:repeat(4,minmax(0,1fr)); } @media(max-width:600px){main{padding:16px}.ap-collection{grid-template-columns:1fr}}
      </style><div id="root"></div></html>`);
    await win.loadFile(path.join(out, 'fixture.html'));
    const run = script => win.webContents.executeJavaScript(script, true);
    await run(`
      var root=${JSON.stringify(root)},path=require('node:path'),fs=require('node:fs'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=key=>dict[key]||key,cache={};
      function load(p){if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s==='../../../components'||s==='../../components')return Object.assign({},...['Button','Icon','Select','Toggle'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;}
      var appearance=load(path.join(root,'renderer/utils/appearance.ts')),library=load(path.join(root,'renderer/utils/theme-library.ts'));
      var profiles=load(path.join(root,'renderer/utils/appearance-profiles.ts'));
      var collection=load(path.join(root,'shared/appearance-collection.ts'));
      var Collection=load(path.join(root,'renderer/components/AppearanceCollection.tsx')).AppearanceCollection;
      var mounted=ReactDOM.createRoot(document.getElementById('root'));window.errors=[];
      window.button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      window.setInput=(selector,value)=>{var el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      function View(){var [background,setBackground]=React.useState(appearance.readAppearance().background),[busy,setBusy]=React.useState(false);
        React.useEffect(()=>{var sync=()=>setBackground(appearance.readAppearance().background);window.addEventListener(appearance.APPEARANCE_EVENT,sync);return()=>window.removeEventListener(appearance.APPEARANCE_EVENT,sync)},[]);
        return React.createElement('main',null,React.createElement('h1',null,t('appearance.collection.title')),React.createElement('p',null,t('appearance.collection.hint')),
          React.createElement(Collection,{background,disabled:busy,onApply:async p=>{setBusy(true);try{await profiles.applyAppearanceProfile(p)}catch(e){errors.push(String(e))}finally{setBusy(false)}}}));}
      appearance.paintAppearance(appearance.readAppearance());mounted.render(React.createElement(View));true;
    `);
    const wait = () => new Promise(resolve => setTimeout(resolve, 100));
    await wait();
    assert.equal(await run(`document.querySelectorAll('.ap-world').length`), 10);
    // Decode every scene, so a CSS path that merely looks correct cannot pass.
    assert.equal(await run(`Promise.all([...document.querySelectorAll('.ap-world-art')].map(el=>new Promise(resolve=>{var img=new Image();img.onload=()=>resolve(img.naturalWidth>0);img.onerror=()=>resolve(false);img.src=getComputedStyle(el).backgroundImage.slice(5,-2)}))).then(values=>values.every(Boolean))`), true);
    const capture = async name => {
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await wait();
      fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await capture('collection');
    // Undo must recover a user's own wallpaper and quick preferences, not just a bundled palette.
    await run(`var canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);
      var personal={...profiles.standardAppearanceProfile(),name:'Personal',mode:'dark',accent:'#DA7643',font:'system',
        appearance:{...appearance.readAppearance(),background:'image',wallpaper:canvas.toDataURL(),backgroundDim:47}};
      profiles.applyAppearanceProfile(personal)`);
    await run(`document.querySelector('.ap-world').click()`); await wait();
    await run(`profiles.restorePreviousAppearanceProfile()`); await wait();
    assert.equal(await run(`JSON.stringify(profiles.captureAppearanceProfile('Personal'))===JSON.stringify(personal)`), true);
    assert.equal(await run(`profiles.loadPreviousAppearanceProfile()===null`), true);
    await run(`localStorage.setItem('reduceMotion','1');localStorage.setItem('density','compact')`);
    for (let i = 0; i < 10; i++) {
      await run(`document.querySelectorAll('.ap-world')[${i}].click()`); await wait();
      const state = await run(`({ background:appearance.readAppearance().background, theme:library.getActiveTheme()?.dark['--color-accent-primary'], selected:document.querySelectorAll('.ap-world[aria-pressed="true"]').length, errors, reduceMotion:localStorage.getItem('reduceMotion'), density:localStorage.getItem('density') })`);
      const expected = await run(`collection.APPEARANCE_COLLECTION[${i}]`);
      assert.equal(state.background, expected.id); assert.equal(state.theme, expected.dark[6]);
      assert.equal(state.selected, 1); assert.deepEqual(state.errors, []);
      assert.equal(state.reduceMotion, '1'); assert.equal(state.density, 'compact');
      assert.equal(await run(`getComputedStyle(document.body,'::before').backgroundImage.includes('/${expected.id}.svg')`), true);
      if (i < 2) await capture(expected.id);
    }
    assert.equal(await run(`library.loadLibrary().length`), 10);
    await run(`document.querySelector('.ap-world').click()`); await wait();
    assert.equal(await run(`library.loadLibrary().length`), 10, 'reapplying a bundled profile reuses the palette');
    assert.equal(await run(`profiles.loadAppearanceProfiles().length`), 0, 'built-ins do not consume personal profile slots');
    await run(`localStorage.setItem('theme','light');library.bootApplyActiveTheme();appearance.paintAppearance(appearance.readAppearance())`);
    assert.equal(await run(`document.documentElement.style.getPropertyValue('--color-bg-primary')`), '#EFF8FC');
    assert.equal(await run(`appearance.readAppearance().background`), 'cyberpunk');
    win.setSize(390, 900); await wait();
    assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`), true);
    await capture('narrow');
    // Exercise the actual settings integration and the unsaved-editor lock.
    win.setSize(1100, 1250); await wait();
    await run(`
      var Panel=load(path.join(root,'renderer/pages/settings/sections/AppearancePanel.tsx')).AppearancePanel;
      var Provider=load(path.join(root,'renderer/components/ThemeEditorContext.tsx')).ThemeEditorProvider;
      function renderPanel(locked){mounted.render(React.createElement(Provider,null,React.createElement('main',{className:'main-content'},React.createElement(Panel,{profilesLocked:locked,onProfileApplied:()=>{}}))))}
      renderPanel(true);true;
    `); await wait();
    assert.equal(await run(`document.querySelectorAll('.ap-world:disabled').length`), 10);
    assert.equal(await run(`document.querySelector('.ap-collection-disclosure').open`), false);
    assert.equal(await run(`document.querySelector('.ap-collection-disclosure').getBoundingClientRect().height<90`), true);
    await capture('settings-collapsed');
    await run(`document.querySelector('.ap-collection-disclosure > summary').click()`); await wait();
    assert.equal(await run(`document.querySelector('.ap-collection').getBoundingClientRect().height>0`), true);
    await run(`renderPanel(false)`); await wait();
    await run(`document.querySelectorAll('.ap-world')[1].click()`); await wait();
    assert.equal(await run(`appearance.readAppearance().background`), 'steampunk');
    assert.equal(await run(`document.querySelectorAll('.ap-world[aria-pressed="true"]').length`), 1);
    assert.equal(await run(`document.querySelector('[role="alert"]')===null`), true);
    assert.equal(await run(`getComputedStyle(document.querySelector('.stg-row-label')).color`), 'rgb(249, 237, 213)');
    // Hidden Chromium windows need a resize to flush inherited-color paint caches.
    win.setSize(1101, 1250); win.setSize(1100, 1250); await wait();
    await capture('settings-wide');
    await run(`document.querySelector('.ap-collection-disclosure > summary').click();document.querySelector('.ap-profiles > summary').click()`); await wait();
    assert.equal(await run(`document.querySelector('.ap-profile-saved')===null`), true);
    await capture('profiles-empty');
    await run(`setInput('.ap-profile-name input','Мой вечерний профиль')`); await wait();
    await run(`button(t('appearance.saveProfile')).click()`); await wait();
    assert.equal(await run(`profiles.loadAppearanceProfiles()[0].name`), 'Мой вечерний профиль');
    assert.equal(await run(`!!button(t('appearance.replaceProfile'))`), true);
    assert.equal(await run(`document.querySelector('[role=status]').textContent.includes('Мой вечерний профиль')`), true);
    await capture('profiles-saved');
    // The standard button clears the whole custom look; undo restores it as one unit.
    await run(`button(t('appearance.standardTheme')).click()`); await wait();
    assert.equal(await run(`library.getActiveTheme()`), null);
    assert.equal(await run(`appearance.readAppearance().background`), 'none');
    assert.equal(await run(`localStorage.getItem('fontChoice')`), null);
    assert.equal(await run(`localStorage.getItem('accentColor')`), null);
    assert.equal(await run(`localStorage.getItem('theme')`), 'system');
    assert.equal(await run(`load(path.join(root,'shared/appearance-profile.ts')).validateAppearanceProfile(JSON.parse(localStorage.getItem('havvn.appearance.previous.v1'))).appearance.background`), 'steampunk');
    await run(`button(t('appearance.restorePrevious')).click()`); await wait();
    assert.equal(await run(`appearance.readAppearance().background`), 'steampunk');
    assert.equal(await run(`library.getActiveTheme().name`), 'Brass & Steam');
    assert.equal(await run(`localStorage.getItem('havvn.appearance.previous.v1')`), null);
    // Deleting a saved profile must not remove the active palette or affect the backdrop.
    await run(`button(t('appearance.deleteProfile')).click()`); await wait();
    assert.equal(await run(`profiles.loadAppearanceProfiles().length`), 0);
    assert.equal(await run(`appearance.readAppearance().background`), 'steampunk');
    await run(`setInput('.ap-profile-name input','Мой вечерний профиль')`); await wait();
    await run(`button(t('appearance.saveProfile')).click()`); await wait();
    win.setSize(390, 900); await wait();
    assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`), true);
    await run(`document.querySelector('.ap-profiles').scrollIntoView({block:'start'})`); await wait();
    await capture('settings-narrow');
    console.log(JSON.stringify({ ok: true, profiles: 10, screenshots: out }));
    clearTimeout(deadline); win.destroy(); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
