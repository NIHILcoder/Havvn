// Real App/Sidebar/views/virtualizer, isolated API and 1000 local downloads.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "havvn-download-views-"),
  );
  const env = { ...process.env, HAVVN_VIEWS_SCRATCH: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
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
    const target = path.resolve(scratch);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith("havvn-download-views-")
    )
      throw Error("Unexpected views fixture");
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
} else {
  const { app, BrowserWindow } = require("electron"),
    root = path.resolve(__dirname, ".."),
    scratch = path.resolve(process.env.HAVVN_VIEWS_SCRATCH || "");
  if (
    path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
    !path.basename(scratch).startsWith("havvn-download-views-")
  )
    throw Error("Missing isolated views profile");
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  const output = path.join(root, "dist/download-views-ui");
  fs.mkdirSync(output, { recursive: true });
  const deadline = setTimeout(() => app.exit(1), 90000);
  app
    .whenReady()
    .then(async () => {
      const settings =
        require("../dist/electron/electron/db/store.js").readSettingsImportState();
      const css =
        require("./smoke-ui-fonts.cjs")(root) +
        [
          "renderer/styles/variables.css",
          "renderer/styles/base.css",
          "renderer/styles/components.css",
          "renderer/styles/layout.css",
          "renderer/pages/DownloadsPage.css",
          "renderer/components/Modal.css",
          "renderer/components/Select.css",
          "renderer/components/NumberInput.css",
          "renderer/components/CommandPalette.css",
          "renderer/pages/DownloadViewsBar.css",
        ]
          .map((file) =>
            fs
              .readFileSync(path.join(root, file), "utf8")
              .replace(/^@import[^;]+;/gm, ""),
          )
          .join("\n");
      const html = path.join(scratch, "ui.html");
      fs.writeFileSync(
        html,
        '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' +
          css +
          '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>',
      );
      const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 960,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          backgroundThrottling: false,
        },
      });
      const errors = [];
      win.webContents.on("console-message", (message) => {
        if (message.level === "error") {
          errors.push(message.message);
          console.error("Renderer:", message.message);
        }
      });
      const run = (code) => win.webContents.executeJavaScript(code),
        pause = () => new Promise((resolve) => setTimeout(resolve, 90));
      const checks = [];
      const metrics = {};
      const capture = async (name) => {
        win.webContents.invalidate();
        await win.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        await run(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
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
      const check = async (label, code) => {
        let ok = false;
        for (let attempt = 0; attempt < 45; attempt++) {
          ok = await run(code);
          if (ok) break;
          await pause();
        }
        if (!ok)
          console.error(
            await run(
              '({title:document.querySelector("h1")?.textContent,errors:[...document.querySelectorAll("[role=alert]")].map(el=>el.textContent),rows:document.querySelectorAll(".downloads-vrow").length,modal:document.querySelector(".um-card")?.textContent.slice(0,400)})',
            ),
          );
        assert.ok(ok, label);
        checks.push(label);
        console.log("PASS " + label);
      };
      const key = (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      };
      const bootstrap = async () => {
        await win.loadFile(html);
        await run(
          "var fixtureRoot=" +
            JSON.stringify(root) +
            ",settingsFixture=" +
            JSON.stringify(settings) +
            ',testSavedViews=true,fixtureCategories=[{id:"movies",name:"Фильмы",icon:"film",color:"#123456"}];\n' +
            fs.readFileSync(
              path.join(__dirname, "fixtures/command-palette-ui.cjs"),
              "utf8",
            ) +
            `
        var model=load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel, views=load(path.join(fixtureRoot,'renderer/utils/download-views.ts')).downloadViews;
        var base=fixtureRows[0];fixtureRows=Array.from({length:1000},(_,i)=>({...base,id:'item-'+i,name:(i%2===0?'Film ':'Archive ')+i,status:i%2===0?'downloading':'paused',category:i%3===0?'movies':null,savePath:i%3===0?'D:/media/movies':'D:/other',totalSize:(i+1)*1048576,createdAt:new Date(1735689600000-i*1000)}));
        model.updateDownloads(()=>fixtureRows);
        function button(key,root=document){return [...root.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
        function input(key,value){var node=[...document.querySelectorAll('.download-views-form label')].find(label=>label.textContent.startsWith(t(key)))?.querySelector('input');if(!node)throw Error('Missing field '+key);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));}
        function chooser(key){return [...document.querySelectorAll('.custom-select-trigger')].find(node=>node.getAttribute('aria-label')===t(key));}
        function chooseText(text){var node=[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===text);if(!node)throw Error('Missing option '+text);node.click();}
        function submit(){document.querySelector('.download-views-form').requestSubmit();}
        function config(){return views.getSnapshot().catalog.views.find(view=>view.id===views.getSnapshot().catalog.activeId);}
        void 0;`,
        );
        await check(
          "1000 downloads share one engine subscription",
          "model.store.getState().downloads.length===1000&&statsSubscriptions===1",
        );
      };
      await bootstrap();
      metrics.mountedRowsAt1000 = await run(
        'document.querySelectorAll(".downloads-vrow").length',
      );
      metrics.filter1000 =
        await run(`(()=>{const compile=load(path.join(fixtureRoot,'shared/download-views.ts')).compileDownloadView;
      const match=compile({status:'downloading',category:'movies',name:'Film',path:'d:/media',minBytes:100*1048576,maxBytes:500*1048576});
      const samples=[];for(let i=0;i<100;i++){const start=performance.now();fixtureRows.filter(match);samples.push(performance.now()-start);}
      samples.sort((a,b)=>a-b);return{iterations:100,medianMs:samples[50],p95Ms:samples[95],rows:fixtureRows.length};})()`);
      await check(
        "Actual title bar and virtualized rows are rendered",
        '!!document.querySelector(".titlebar .titlebar-commands")&&document.querySelectorAll(".downloads-vrow").length>0&&document.querySelectorAll(".downloads-vrow").length<100',
      );
      await run('button("views.conditions").click()');
      await pause();
      await check('Size limits use themed number controls instead of system arrows', `document.querySelectorAll('.download-views-grid .number-input-controls button').length===4`);
      await run(`input('views.minSize','1.5')`);
      await run(`document.querySelector('input[aria-label="'+t('views.minSize')+'"]').closest('.number-input').querySelector('button').click();void 0`);
      await check('Fractional size limits can be stepped without a native step=any exception', `document.querySelector('input[aria-label="'+t('views.minSize')+'"]').value==='2.5'`);
      await run(`input('views.minSize','')`);
      await check('An empty size limit stays empty and optional', `document.querySelector('input[aria-label="'+t('views.minSize')+'"]').value===''`);
      await run('chooser("views.status").click()');
      await pause();
      await run('chooseText(t("filter.downloading"))');
      await run('chooser("views.category").click()');
      await pause();
      await run('chooseText("Фильмы")');
      for (const [field, value] of [
        ["views.nameContains", "Film"],
        ["views.pathContains", "d:\\media"],
        ["views.minSize", "100"],
        ["views.maxSize", "500"],
      ])
        await run(
          "input(" + JSON.stringify(field) + "," + JSON.stringify(value) + ")",
        );
      await run("submit()");
      await pause();
      await pause();
      await check(
        "All conditions combine and the filtered count is correct",
        'document.querySelector(".results-count")?.textContent.includes("67")',
      );
      await run('button("downloads.sortName").click()');
      await pause();
      await run('button("downloads.sortName").click()');
      await pause();
      await run('button("downloads.tools").click()');
      await pause();
      await run('button("downloads.detailedView").click()');
      await run('button("views.save").click()');
      await pause();
      await run('input("views.name","Фильмы 100–500 МиБ");submit()');
      await pause();
      await pause();
      await check(
        "Saved view includes conditions, detailed mode and pin",
        'config()?.mode==="detailed"&&config().sort.by==="name"&&config().sort.direction==="asc"&&config().conditions.minBytes===104857600&&config().pinned&&!!document.querySelector(".sidebar .download-view-name")',
      );
      await capture("wide.png");
      await run('document.querySelector(".modern-search-input").focus()');
      key("a", ["control"]);
      await pause();
      await check(
        "Typing Ctrl+A does not select downloads",
        '!document.querySelector(".bulk-actions-count")',
      );
      await run(
        'document.querySelector("h1").tabIndex=-1;document.querySelector("h1").focus()',
      );
      key("a", ["control"]);
      await pause();
      await check(
        "Ctrl+A selects only 67 filtered downloads",
        'document.querySelector(".bulk-actions-count")?.textContent.includes("67")',
      );
      await run(
        'var stats=fixtureRows.map(row=>({...row,id:row.id,status:row.id==="item-102"?"completed":row.status}));fixtureRows=fixtureRows.map(row=>row.id==="item-102"?{...row,status:"completed"}:row);statsReceiver(stats)',
      );
      await pause();
      await check(
        "A live status change immediately updates membership and selection",
        'document.querySelector(".results-count")?.textContent.includes("66")&&document.querySelector(".bulk-actions-count")?.textContent.includes("66")',
      );
      await run('button("views.rename").click()');
      await pause();
      await run('input("views.name","Кино");submit()');
      await pause();
      await check(
        "Rename updates the pinned entry without changing view identity",
        'config()?.name==="Кино"&&document.querySelector(".sidebar .download-view-name")?.textContent==="Кино"',
      );
      await run('button("views.unpin").click()');
      await pause();
      await check(
        "Unpin removes only the shortcut",
        '!document.querySelector(".sidebar .download-view-name")&&views.getSnapshot().catalog.views.length===1',
      );
      await run('button("views.pin").click()');
      await pause();
      await run(
        "fixtureCategories=[];fixtureRows=fixtureRows.map(row=>({...row,category:null}));model.updateDownloads(()=>fixtureRows)",
      );
      await pause();
      await check(
        "Deleting a category preserves its condition and shows an empty view",
        'config().conditions.category==="movies"&&!!document.querySelector(".download-views-note")&&!!document.querySelector(".empty-state")',
      );
      await run("commandsButton().click()");
      await check(
        "Palette opens after loading its lazy chunk",
        '!!document.querySelector(".command-palette-input")',
      );
      await run('setQuery("Кино")');
      await pause();
      await check(
        "Saved views are indexed in the command palette",
        '[...document.querySelectorAll("[data-command-id]")].some(node=>node.dataset.commandId.startsWith("download-view:"))',
      );
      key("Enter");
      await pause();
      await run(
        'document.querySelectorAll(".sidebar .nav-subitem")[0].click()',
      );
      await pause();
      await check(
        "Quick filters leave the saved view and restore a usable list",
        'views.getSnapshot().catalog.activeId===null&&document.querySelectorAll(".downloads-vrow").length>0&&!document.querySelector(".bulk-actions-count")',
      );
      await run(
        'document.querySelector(".sidebar .download-view-name").closest("button").click()',
      );
      await pause();
      await check(
        "Pinned entry reapplies the saved conditions",
        'config()?.name==="Кино"&&!!document.querySelector(".empty-state")',
      );
      await bootstrap();
      await check(
        "Renderer restart restores the active view and its layout",
        'config()?.name==="Кино"&&config().sort.by==="name"&&config().sort.direction==="asc"&&document.querySelector(".sort-chip.active")?.textContent.includes(t("downloads.sortName"))&&!!document.querySelector(".downloads-list-detailed")&&document.querySelector(".results-count")?.textContent.includes("67")',
      );
      await run('button("views.conditions").click()');
      await pause();
      await run(
        'input("views.minSize","900");input("views.maxSize","10");submit()',
      );
      await pause();
      await check(
        "Invalid size bounds remain in the dialog without changing the view",
        '!!document.querySelector(".um-card [role=alert]")&&config().conditions.minBytes===104857600',
      );
      key("Escape");
      await pause();
      await run('button("views.conditions").click()');
      await pause();
      await run(
        'dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,"renderer/i18n/en.json"),"utf8"));document.documentElement.lang="en";fixtureSetLanguage("en");views.pin(config().id)',
      );
      await pause();
      win.setSize(760, 900);
      await pause();
      await check(
        "Filter dialog fits a narrow window with shared styled buttons",
        'document.querySelector(".um-card").getBoundingClientRect().right<=innerWidth&&document.querySelector(".download-views-form button[type=submit]").classList.contains("btn")',
      );
      win.webContents.invalidate();
      await win.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      await run(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      fs.writeFileSync(
        path.join(output, "filters.png"),
        (
          await win.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
        ).toPNG(),
      );
      key("Escape");
      await pause();
      await capture("narrow.png");
      await run('button("views.delete").click()');
      await pause();
      await check(
        "Deleting a preset uses the shared confirmation dialog",
        '!!document.querySelector(".um-backdrop-top .btn-danger")',
      );
      await run(
        'document.querySelector(".um-backdrop-top .btn-danger").click()',
      );
      await pause();
      await check(
        "Delete removes only the view and keeps all downloads",
        "views.getSnapshot().catalog.views.length===0&&model.store.getState().downloads.length===1000",
      );
      assert.deepEqual(errors, []);
      fs.writeFileSync(
        path.join(output, "report.json"),
        JSON.stringify({ passed: true, checks, metrics }, null, 2),
      );
      await run("tree.unmount()");
      win.destroy();
      clearTimeout(deadline);
      console.log(
        JSON.stringify({ passed: true, checks: checks.length, output }),
      );
      app.quit();
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
