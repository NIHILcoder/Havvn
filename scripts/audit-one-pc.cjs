// Run only owned, isolated acceptance fixtures. Each command has its own log.
const fs = require('node:fs'), path = require('node:path'), { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/one-pc-audit-20261106');
const suites = {
  rooms: [
    ['file-editor','smoke-room-file-sync.cjs','--ui','--editor'],
    ['writers','smoke-room-file-sync.cjs','--writers'],
    ['documents','smoke-room-file-sync.cjs','--ui','--documents'],
    ['windows-faults','smoke-room-file-sync.cjs','--faults'],
    ['moves','smoke-room-file-sync.cjs','--ui','--moves'],
    ['deletes','smoke-room-file-sync.cjs','--ui','--deletes'],
    ['missing','smoke-room-file-sync.cjs','--ui','--missing'],
    ['paths','smoke-room-file-sync.cjs','--ui','--paths'],
    ['metadata','smoke-room-file-sync.cjs','--ui','--metadata'],
    ['history','smoke-room-file-sync.cjs','--ui','--history'],
    ['compaction','smoke-room-file-sync.cjs','--ui','--compaction'],
    ['checkpoint','smoke-room-file-sync.cjs','--ui','--checkpoint'],
    ['multipart','smoke-room-file-sync.cjs','--ui','--multipart'],
    ['library','smoke-room-file-sync.cjs','--ui','--library'],
    ['trash-storage','smoke-room-file-sync.cjs','--ui','--trash-storage'],
  ],
  services: [
    ['room-lifecycle','smoke-room-lifecycle.cjs'],
    ['room-invites','smoke-room-invites.cjs'],
    ['room-key-rotation','smoke-room-key-rotation.cjs'],
    ['room-chat-tools','smoke-room-chat-tools.cjs'],
    ['room-controls','smoke-room-controls.cjs'],
    ['room-network-lifecycle','smoke-room-network-lifecycle.cjs'],
    ['screen-view','smoke-screen-view-ui.cjs'],
    ['device-vault','smoke-device-vault.cjs'],
    ['device-tls','smoke-device-tls.cjs'],
    ['device-data','smoke-device-data.cjs'],
    ['device-ui','smoke-device-ui.cjs'],
    ['web-remote','smoke-web-remote.cjs'],
    ['provider-network','smoke-provider-network-electron.cjs'],
    ['http-mirrors','smoke-http-mirrors.cjs'],
    ['rss-and-settings','smoke-functional-audit.cjs'],
    ['profiles','smoke-working-profiles.cjs'],
    ['settings-transfer','smoke-settings-transfer.cjs'],
    ['settings-transfer-ui','smoke-settings-transfer-ui.cjs'],
    ['settings-usability','smoke-settings-usability.cjs'],
    ['effective-settings','smoke-effective-settings.cjs'],
    ['player-seek-and-tracks','smoke-player-preferences.cjs'],
    ['player-buffer','smoke-player-buffer.cjs'],
    ['lazy-player','smoke-lazy-player.cjs'],
    ['external-player','smoke-external-player.cjs'],
    ['external-stream','smoke-external-stream.cjs'],
    ['watch-history','smoke-watch-history.cjs'],
    ['security-boundaries','smoke-security-boundaries.cjs'],
    ['storage','smoke-storage-overview.cjs'],
    ['sync-work','smoke-sync-work.cjs'],
  ],
};
const group = process.argv.find(arg => arg.startsWith('--group='))?.slice(8);
const filter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
if (!suites[group]) throw Error('Choose --group=rooms or --group=services');
fs.mkdirSync(output, { recursive:true });
const reportPath = path.join(output, group + (filter ? '-' + filter.replace(/[^a-z0-9-]/gi,'') : '') + '.json');
const report = { startedAt:new Date().toISOString(), version:require('../package.json').version, physicalMachines:1, group, cases:[] };
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report,null,2));
(async () => {
  for (const [name, script, ...args] of suites[group].filter(row => !filter || row[0] === filter)) {
    const startedAt = Date.now(), log = path.join(output, name + '.log'), stream = fs.createWriteStream(log);
    const entry = { name, command:[script,...args], startedAt:new Date(startedAt).toISOString(), status:'running', log };
    report.cases.push(entry); save(); console.log('START ' + name);
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname,script),...args], { cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe'] });
      child.stdout.pipe(stream,{end:false}); child.stderr.pipe(stream,{end:false});
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true;
        if (process.platform === 'win32' && child.pid) spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        else child.kill();
      }, 360000);
      child.once('error',error=>{clearTimeout(timer);resolve({exitCode:null,error:String(error),timedOut});});
      child.once('exit',code=>{clearTimeout(timer);resolve({exitCode:code,timedOut});});
    });
    await new Promise(resolve=>stream.end(resolve));
    Object.assign(entry,result,{status:result.exitCode===0?'passed':'failed',durationMs:Date.now()-startedAt});
    save();console.log(entry.status.toUpperCase()+' '+name+' '+entry.durationMs+'ms');
  }
  report.finishedAt = new Date().toISOString(); report.passed = report.cases.length>0&&report.cases.every(row=>row.status==='passed'); save();
  process.exitCode = report.passed ? 0 : 1;
})().catch(error=>{console.error(error);process.exitCode=1;});
