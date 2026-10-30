/* eslint-disable @typescript-eslint/no-require-imports -- Native UI acceptance with isolated profiles and synthetic room state. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/fun05/ui');
if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ passed: false, startedAt: new Date().toISOString(), checks: [] }));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-preflight-'));
  const env = { ...process.env, HAVVN_PREFLIGHT_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => {
    const target = path.resolve(profile);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-preflight-')) throw Error('Unexpected test profile');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    const proof = JSON.parse(fs.readFileSync(path.join(output, 'acceptance.json'), 'utf8'));
    process.exitCode = code === 0 && proof.passed && proof.checks.length && proof.checks.every(check => check.passed) ? 0 : 1;
  });
} else {
  const { app, BrowserWindow, session } = require('electron');
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.HAVVN_PREFLIGHT_PROFILE);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('Preflight UI deadline'); app.exit(1); }, 90_000);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    // No public service, room, device permission or user's profile is used.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    const checks = [], record = id => checks.push({ id, passed: true });
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ passed: false, startedAt: new Date().toISOString(), checks }));
    const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/Modal.css', 'renderer/pages/rooms/RoomLanPanel.css', 'renderer/pages/rooms/RoomActionHint.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(output, 'fixture.html');
    fs.writeFileSync(page, '<html lang="ru"><meta charset="utf-8"><style>' + css + '#root{padding:16px}.um-backdrop,.um-card{animation:none!important}</style><div id="root"></div></html>');
    await win.loadFile(page);
    const run = code => win.webContents.executeJavaScript(code), settle = () => new Promise(resolve => setTimeout(resolve, 120));
    await run(`var fixtureRoot=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),pr=require('node:module').createRequire(path.join(fixtureRoot,'package.json'));
      var React=pr('react'),ReactDOM=pr('react-dom'),ts=pr('typescript'),cache={},dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/ru.json'),'utf8'));
      function load(file){if(cache[file])return cache[file].exports;const m={exports:{}};cache[file]=m;
        const src=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',src)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t:k=>dict[k]||k})};
          if(s==='../../components')return {Button:load(path.join(fixtureRoot,'renderer/components/Button.tsx')).Button,Modal:load(path.join(fixtureRoot,'renderer/components/Modal.tsx')).Modal,
            Avatar:load(path.join(fixtureRoot,'renderer/components/Avatar.tsx')).Avatar,Icon:load(path.join(fixtureRoot,'renderer/components/Icon.tsx')).default,useConfirm:()=>({confirm:()=>new Promise(resolve=>{window.accept=resolve})})};
          if(s.startsWith('.')){const q=path.resolve(path.dirname(file),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}return pr(s);
        },m,m.exports);return m.exports;}
      var view=pr('react-dom/client').createRoot(document.getElementById('root')),Hint=load(path.join(fixtureRoot,'renderer/pages/rooms/RoomActionHint.tsx')).RoomActionHint,
        Picker=load(path.join(fixtureRoot,'renderer/pages/rooms/LanPeerPicker.tsx')).LanPeerPicker;
      window.people=[{memberId:'known',name:'Поддерживаемый участник',avatarSeed:'a',online:true,capabilities:['lan']},{memberId:'legacy',name:'Старый клиент',avatarSeed:'b',online:true}];
      window.picks=[];window.mount=(key='picker')=>ReactDOM.flushSync(()=>view.render(React.createElement(Picker,{key,members:people,onClose:()=>{},onPick:ids=>picks.push(ids)})));
      window.hint=check=>ReactDOM.flushSync(()=>view.render(React.createElement(Hint,{check})));void 0;
    `);
    for (const status of ['unknown', 'unsupported', 'unavailable']) {
      await run(`hint({status:${JSON.stringify(status)},reason:'capability-unknown',next:'update',canAttempt:false})`); await settle();
      assert.equal(await run(`document.querySelector('[data-room-action-status]').dataset.roomActionStatus`), status);
      assert.equal(await run('document.body.innerText.includes("rooms.preflight.")'), false);
    }
    record('localized-action-statuses');
    await run(`hint({status:'supported',reason:'ready',next:'continue',canAttempt:true})`);
    assert.equal(await run('!!document.querySelector(".room-action-hint")'), false); record('no-success-banner-or-checkmark');
    await run('mount()'); await settle();
    assert.equal(await run('document.querySelectorAll(".lpp-tile")[1].disabled'), true); record('unknown-client-disabled-before-elevation');
    await run('document.querySelectorAll(".lpp-tile")[0].click()'); await settle();
    assert.equal(await run('!!document.querySelector(".lpp-selection") && !document.querySelector(".lpp-selection").textContent'), true); record('centered-css-selection-without-glyph');
    await run('document.querySelector(".lpp-footer button").click()'); await settle();
    await run('people=people.map(m=>({...m,capabilities:undefined}));mount();accept(true);void 0'); await settle();
    assert.equal(await run('picks.length'), 0);
    assert.equal(await run('!!document.querySelector("[data-room-action-status=unknown]")'), true);
    record('roster-changed-during-confirmation-does-not-start-lan');
    for (const width of [1100, 700, 400]) {
      win.setContentSize(width, 900); await settle();
      assert.equal(await run('Array.from(document.querySelectorAll(".lpp-footer button,.lpp-tile,.room-action-hint")).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&e.scrollWidth<=e.clientWidth+1})'), true, 'Controls fit at ' + width);
      fs.writeFileSync(path.join(output, 'lan-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    record('desktop-controls-fit-1100-700-400');
    await run('document.querySelectorAll(".lpp-tile")[0].click()'); await settle();
    assert.equal(await run('!!document.querySelector(".room-action-hint")'), false);
    await run('view.unmount();void 0'); win.destroy();
    const guestCss = fs.readFileSync(path.join(root, 'docs/room/styles.css'), 'utf8');
    const guestPage = path.join(output, 'guest.html'); fs.writeFileSync(guestPage, '<html><meta charset="utf-8"><style>' + guestCss + '</style><div id="app"></div></html>');
    const bundle = fs.readFileSync(path.join(root, 'docs/room/guest.js'), 'utf8');
    for (const mode of ['ready', 'no-webrtc', 'no-crypto']) {
      const guest = new BrowserWindow({ show: false, width: 400, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
      await guest.loadFile(guestPage);
      await guest.webContents.executeJavaScript(`window.createdPeers=0;var OriginalPeer=window.RTCPeerConnection;
        window.RTCPeerConnection=class extends OriginalPeer{constructor(...args){super(...args);createdPeers++}};
        ${mode === 'no-webrtc' ? 'window.RTCPeerConnection=undefined;' : mode === 'no-crypto' ? 'Object.defineProperty(globalThis,"crypto",{value:{},configurable:true});' : ''}
      ` + bundle);
      const evaluate = code => guest.webContents.executeJavaScript(code); await settle();
      await evaluate('document.querySelector("[data-lang=ru]").click()'); await settle();
      assert.equal(await evaluate('document.querySelector("[data-act=join]").disabled'), mode !== 'ready');
      assert.equal(await evaluate('document.querySelector("[data-entry-status]").dataset.entryStatus'), mode === 'ready' ? 'unknown' : 'unsupported');
      assert.equal(await evaluate('createdPeers'), 0);
      if (mode !== 'ready') {
        await evaluate('document.querySelector("#invite").value="synthetic-invite";document.querySelector("[data-act=join]").disabled=false;document.querySelector("[data-act=join]").click()'); await settle();
        assert.equal(await evaluate('createdPeers'), 0); assert.equal(await evaluate('document.querySelector("[data-act=join]").disabled'), true);
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true);
      fs.writeFileSync(path.join(output, 'guest-' + mode + '.png'), (await guest.webContents.capturePage()).toPNG());
      record('guest-entry-' + mode + '-runtime-rechecked-no-auto-join'); guest.destroy();
    }
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ passed: true, checks, checkedAt: new Date().toISOString(), scope: 'Real Electron/React and built guest UI; synthetic roster, no real room, LAN helper or Internet route measured' }, null, 2));
    console.log('FUN-05 UI passed:', checks.length, output); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
