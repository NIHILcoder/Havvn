/* eslint-disable @typescript-eslint/no-require-imports -- Isolated actual React controls, synthetic API. */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-settings-ui-"));
  env.HAVVN_SETTINGS_UI_SCRATCH = scratch;
  const child = require("node:child_process").spawn(
    require("electron"),
    [__filename],
    { env, windowsHide: true, stdio: "inherit" },
  );
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
    const resolved = path.resolve(scratch);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("havvn-settings-ui-")
    )
      throw new Error("Unexpected UI fixture directory");
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
} else {
  const { app, BrowserWindow } = require("electron");
  const scratch = path.resolve(process.env.HAVVN_SETTINGS_UI_SCRATCH || "");
  if (
    path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
    !path.basename(scratch).startsWith("havvn-settings-ui-")
  )
    throw new Error("Missing isolated UI profile");
  const root = path.resolve(__dirname, ".."),
    output = path.join(root, "dist/settings-transfer-ui");
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 45000);
  app
    .whenReady()
    .then(async () => {
      const db = require(path.join(root, "dist/electron/electron/db/store.js"));
      const fixture = db.readSettingsImportState();
      fs.mkdirSync(output, { recursive: true });
      const css =
        require("./smoke-ui-fonts.cjs")(root) +
        [
          "renderer/styles/variables.css",
          "renderer/styles/base.css",
          "renderer/styles/components.css",
          "renderer/pages/settings/controls.css",
          "renderer/components/Select.css",
        ]
          .map((file) =>
            fs
              .readFileSync(path.join(root, file), "utf8")
              .replace(/^@import[^;]+;/gm, ""),
          )
          .join("\n");
      const page = path.join(scratch, "ui.html");
      fs.writeFileSync(
        page,
        `<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>${css}body{padding:20px;height:100vh;overflow:hidden}#root{max-width:1000px;height:calc(100vh - 40px);overflow:auto;margin:auto}output{display:block;margin:8px 0;min-height:20px}</style><div id="root"></div></html>`,
      );
      const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 900,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          backgroundThrottling: false,
        },
      });
      const errors = [];
      win.webContents.on("console-message", (details) => {
        if (details.level === "error") {
          errors.push(details.message);
          console.error("UI fixture:", details.message);
        }
      });
      await win.loadFile(page);
      win.webContents.debugger.attach('1.3');
      const run = (code) =>
          win.webContents.executeJavaScript(
            `(()=>{try{return (0,eval)(${JSON.stringify(code)})}catch(error){console.error(error.stack);throw error;}})()`,
          ),
        pause = () => new Promise((resolve) => setTimeout(resolve, 60));
      await run(`
      var root=${JSON.stringify(root)}, fixture=${JSON.stringify(fixture)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var packageRequire=require('node:module').createRequire(path.join(root,'package.json'));
      var React=packageRequire('react'), dom=packageRequire('react-dom/client'), cache={}, calls=[], transferStatus={backupAt:null,recoveryNeeded:false}, delayImport=false, completeImport;
      var exportOwner, exportChanged, holdExport=false, completeExport, cancelExport=false;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=key=>dict[key]||key;
      window.api=new Proxy({getSettings:async()=>structuredClone(fixture.settings),getPrivacyConfig:async()=>fixture.privacyConfig,getScheduler:async()=>fixture.scheduler,
        getAppStats:async()=>({totalDownloads:0,totalUploaded:'0',totalDownloaded:'0',diskUsage:'0',activeDownloads:0,completedDownloads:0}),getDohTemplates:async()=>[],getNetworkProfiles:async()=>({profiles:[],activeId:null,current:null}),
        getAutoLaunch:async()=>false,isDefaultClient:async()=>false,getAppVersion:async()=>'3.2.0',getRunningEngine:async()=>'native',getRunningTransport:async()=>null,webRemote:{getInfo:async()=>({enabled:false})},
        getSettingsTransferStatus:async()=>({...transferStatus}),
        getSettingsExportOperation:async()=>exportOwner.snapshot(),onSettingsExportOperation:fn=>{exportChanged=fn;return()=>{exportChanged=undefined}},
        exportSettings:async options=>{var id=exportOwner.start('choose-file','save-dialog',['cancel-in-dialog']);calls.push(['export',options]);
          if(holdExport)await new Promise(resolve=>completeExport=resolve);
          if(cancelExport){exportOwner.finish(id,'cancelled');return{success:false}}
          exportOwner.update(id,{stage:'write-export',status:'running',progress:null,waitingFor:null,actions:[]});exportOwner.finish(id,'succeeded');return{success:true}},
        importSettings:async options=>{calls.push(['import',options]);if(delayImport)await new Promise(resolve=>completeImport=resolve);transferStatus.backupAt=new Date().toISOString();return{success:true}},
        restoreSettings:async options=>{calls.push(['restore',options]);return{success:true}},recoverSettingsTransfer:async()=>{calls.push(['recover']);transferStatus.recoveryNeeded=false;return{success:true}}
      },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;
        var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(id=>{
          if(id.endsWith('.css'))return{};
          if(id.includes('i18nContext'))return{useTranslation:()=>({t,language:'ru',setLanguage:()=>{}})};
          if(id.endsWith('/components')){var out={};for(var name of ['Button','Icon','Select'])Object.assign(out,load(path.join(root,'renderer/components/'+name+'.tsx')));return out;}
          if(id.startsWith('.')){var next=path.resolve(path.dirname(file),id);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(next+ext))return load(next+ext);throw Error(next);}
          return packageRequire(id);
        },m,m.exports);return m.exports;}
      exportOwner=load(path.join(root,'shared/operations.ts')).createOperationOwner(()=>exportChanged?.());
      var settings=load(path.join(root,'renderer/pages/settings/SettingsContext.tsx')), editor=load(path.join(root,'renderer/components/ThemeEditorContext.tsx'));
      var System=load(path.join(root,'renderer/pages/settings/sections/SystemSection.tsx')).SystemSection, mounted=dom.createRoot(document.getElementById('root'));
      function Probe(){window.ctx=settings.useSettings();window.themeEditor=editor.useThemeEditor();return React.createElement('output',{role:'status'},ctx.message?.text||'');}
      function mount(){mounted.render(React.createElement(editor.ThemeEditorProvider,null,React.createElement(settings.SettingsProvider,null,React.createElement(Probe),React.createElement(System))));}
      function button(key){return [...document.querySelectorAll('button')].find(el=>el.textContent.trim()===t(key));}
      mount();true;
    `);
      await pause();
      await pause();
      const sectionBounds = await run(`(()=>{const group=document.querySelector('fieldset'),title=group.querySelector('legend');const g=group.getBoundingClientRect(),t=title.getBoundingClientRect();return {group:{top:g.top,left:g.left,right:g.right,bottom:g.bottom},title:{top:t.top,left:t.left,right:t.right,bottom:t.bottom}}})()`);
      assert.ok(sectionBounds.group.top + 6 <= sectionBounds.title.top && sectionBounds.group.bottom >= sectionBounds.title.bottom
        && sectionBounds.group.left + 6 <= sectionBounds.title.left && sectionBounds.group.right >= sectionBounds.title.right + 6,
      'group highlight must enclose its visible title with breathing room: ' + JSON.stringify(sectionBounds));
      const ax = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
      const groupName = await run(`t('settings.transfer.sections')`);
      assert.ok(ax.nodes.some(node => node.role?.value === 'group' && node.name?.value === groupName), 'native group keeps its spoken name');
      assert.equal(ax.nodes.filter(node => node.role?.value === 'checkbox').length, 7, 'all transfer choices remain accessible');
      assert.equal(
        await run(
          `document.querySelectorAll('fieldset input[type=checkbox]').length`,
        ),
        7,
      );
      assert.equal(
        await run(`button('settings.transfer.restore').disabled`),
        true,
      );
      await run(
        `for(const checkbox of document.querySelectorAll('fieldset input'))checkbox.click();`,
      );
      await pause();
      assert.equal(
        await run(
          `button('settings.export').disabled&&button('settings.import').disabled`,
        ),
        true,
      );
      await run(`document.querySelectorAll('fieldset input')[5].focus()`);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
      await pause();
      assert.deepEqual(await run(`ctx.selectedTransferSections`), ["hotkeys"]);
      await run(`button('settings.export').click()`);
      await pause();
      assert.deepEqual(
        await run(`calls.find(call=>call[0]==='export')[1].sections`),
        ["hotkeys"],
      );
      await run(`delayImport=true;button('settings.import').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await pause();
      assert.equal(
        await run(
          `document.querySelector('fieldset').disabled&&button('settings.import').disabled`,
        ),
        true,
      );
      await run(`completeImport()`);
      await pause();
      await pause();
      assert.equal(
        await run(`button('settings.transfer.restore').disabled`),
        false,
      );
      await run(`button('settings.transfer.restore').click()`);
      await pause();
      assert.deepEqual(
        await run(`calls.find(call=>call[0]==='restore')[1].sections`),
        ["hotkeys"],
      );
      assert.equal(
        await run(`document.querySelector('output').textContent`),
        await run(`t('settings.transfer.restored')`),
      );
      await run(
        `ctx.setDefaultDownloadDir(ctx.settings.defaultDownloadDir+'-draft')`,
      );
      await pause();
      const exportsBefore = await run(
        `calls.filter(call=>call[0]==='export').length`,
      );
      await run(`button('settings.export').click()`);
      await pause();
      assert.equal(
        await run(`calls.filter(call=>call[0]==='export').length`),
        exportsBefore,
      );
      assert.equal(
        await run(`document.querySelector('output').textContent`),
        await run(`t('settings.transfer.finishEditing')`),
      );
      await run(
        `ctx.setDefaultDownloadDir(ctx.settings.defaultDownloadDir);themeEditor.openEditor()`,
      );
      await pause();
      const importsBefore = await run(
        `calls.filter(call=>call[0]==='import').length`,
      );
      await run(`button('settings.import').click()`);
      await pause();
      assert.equal(
        await run(`calls.filter(call=>call[0]==='import').length`),
        importsBefore,
      );
      const capture = async (name) => {
        await run(
          `document.querySelector('fieldset').closest('.stg-card').scrollIntoView({block:'start'}); document.fonts.ready.then(()=>true)`,
        );
        await win.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 160));
        fs.writeFileSync(
          path.join(output, name),
          (
            await win.webContents.capturePage(undefined, {
              stayHidden: true,
              stayAwake: true,
            })
          ).toPNG(),
        );
      };
      await run(`themeEditor.closeEditor()`);
      await pause();
      await run(`holdExport=true;cancelExport=true;button('settings.export').click()`);
      await pause();
      assert.equal(await run(`document.querySelector('[data-operation-stage="choose-file"]').textContent.includes(t('operation.wait.save-dialog'))`), true);
      assert.equal(await run(`document.querySelector('.operation-status [role=progressbar]').hasAttribute('aria-valuenow')`), false);
      assert.equal(await run(`button('settings.import').disabled && button('settings.export').disabled`), true);
      // Leaving settings does not cancel work. A remount must observe the main owner's active attempt.
      await run(`mounted.unmount();mounted=dom.createRoot(document.getElementById('root'));mount();true;`);
      await pause(); await pause();
      assert.equal(await run(`button('settings.export').disabled`), true);
      await run(`completeExport()`); await pause(); await pause();
      assert.equal(await run(`document.querySelector('[data-operation-status="cancelled"]')!==null`), true);
      assert.equal(await run(`button('settings.export').disabled`), false);
      await capture("export-cancelled.png");
      await capture("wide.png");
      await run(`document.querySelector('fieldset').setAttribute('data-settings-search-target','')`);
      await capture("sections-highlight.png");
      await run(`document.querySelector('fieldset').removeAttribute('data-settings-search-target')`);
      win.setSize(520, 820);
      await pause();
      assert.equal(
        await run(`document.documentElement.scrollWidth<=innerWidth`),
        true,
      );
      await capture("narrow.png");
      await run(`document.querySelector('fieldset').setAttribute('data-settings-search-target','')`);
      await capture("sections-highlight-narrow.png");
      const narrowBounds = await run(`(()=>{const group=document.querySelector('fieldset'),g=group.getBoundingClientRect(),title=group.querySelector('legend').getBoundingClientRect();return {top:g.top,titleTop:title.top,left:g.left,titleLeft:title.left,right:g.right,titleRight:title.right}})()`);
      assert.ok(narrowBounds.titleTop >= narrowBounds.top + 6 && narrowBounds.titleLeft >= narrowBounds.left + 6 && narrowBounds.titleRight <= narrowBounds.right - 6, 'wrapped group title stays inside the narrow highlight');
      await run(`document.querySelector('fieldset').removeAttribute('data-settings-search-target')`);
      win.setSize(1100, 900);
      await pause();
      await capture("wide.png");
      await run(
        `mounted.unmount();transferStatus.recoveryNeeded=true;mounted=dom.createRoot(document.getElementById('root'));mount();true;`,
      );
      await pause();
      await pause();
      assert.equal(await run(`button('settings.import').disabled`), true);
      await run(`button('settings.transfer.recover').click()`);
      await pause();
      await pause();
      assert.equal(await run(`calls.some(call=>call[0]==='recover')`), true);
      assert.equal(
        await run(`button('settings.transfer.recover')===undefined`),
        true,
      );
      assert.deepEqual(errors, []);
      await run(`mounted.unmount()`);
      win.destroy();
      clearTimeout(deadline);
      console.log(
        JSON.stringify({
          passed: true,
          checks: [
            "real SettingsProvider/SystemSection",
            "section masks",
            "keyboard selection",
            "empty selection",
            "busy state",
            "restore availability",
            "unsaved form guard",
            "theme draft guard",
            "recovery action",
            "520px layout",
            "export waiting stage without artificial percent",
            "export observation after settings remount",
            "confirmed native-dialog cancellation",
            "group highlight encloses title at wide and narrow widths",
            "native group name and all seven checkboxes in Chromium accessibility tree",
          ],
          output,
        }),
      );
      app.quit();
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
