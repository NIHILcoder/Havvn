/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node/Electron harness. */
/* Isolated renderer baseline. No production backend or external network. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const metrics=require('./performance-baseline-metrics.cjs'),root=path.resolve(__dirname,'..');
const scenarios=[
  {id:'empty-start',downloads:0,files:0,messages:0,history:0,emptyRooms:true},
  {id:'downloads-100',downloads:100,files:0,messages:0,history:0,emptyRooms:true},
  {id:'downloads-1000',downloads:1000,files:0,messages:0,history:0,emptyRooms:true},
  {id:'room-history',downloads:0,files:1000,messages:10000,history:2000},
  {id:'heavy-remount',downloads:1000,files:1000,messages:200,history:0},
];
function option(name,fallback){const at=process.argv.indexOf(name);return at<0?fallback:process.argv[at+1]}
const flag=name=>process.argv.includes(name);
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2))};
if(!process.versions.electron){
  const quick=flag('--quick'),output=path.resolve(option('--output',path.join(root,'artifacts/performance-baseline',quick?'ci':'current')));
  const options={quick,runs:Number(option('--runs',quick?1:3)),sampleMs:Number(option('--sample-ms',quick?1000:6000)),warmupMs:quick?400:1500,cycles:quick?3:8,gpu:flag('--gpu'),showWindow:flag('--show-window'),resourceMode:option('--resource-mode','normal'),statsTickMs:Number(option('--stats-tick-ms',750)),visibility:option('--visibility','visible'),scenario:option('--scenario',null)};
  if(!['visible','hidden'].includes(options.visibility)||options.scenario&&!scenarios.some(row=>row.id===options.scenario))throw Error('Invalid visibility or scenario');
  const selected=scenarios.filter(row=>!options.scenario||row.id===options.scenario);
  if(!['normal','economy'].includes(options.resourceMode)||!Number.isFinite(options.statsTickMs)||options.statsTickMs<50||options.statsTickMs>1000)throw Error('Invalid resource mode or update cadence');
  if(!Number.isInteger(options.runs)||options.runs<1||options.runs>10||!Number.isFinite(options.sampleMs)||options.sampleMs<750||options.sampleMs>30000)throw Error('Invalid run count or duration');
  if(option('--compare',null)&&path.resolve(option('--compare',null))===path.join(output,'summary.json'))throw Error('Use a different output folder to preserve the reference baseline');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-baseline-'));
  const cleanup=()=>{const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('havvn-baseline-'))throw Error('Unexpected scratch path');fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
  const main=async()=>{
    const source=metrics.sourceSnapshot(root);
    const git={head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:cp.execFileSync('git',['-c','core.quotePath=false','status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean)};
    write(path.join(output,'source-manifest.json'),{...source,git});
    const config=require('../webpack.renderer.config.js')({}, {mode:'production'});
    config.context=root;config.mode='production';config.devtool=false;config.entry=path.join(__dirname,'performance-renderer-entry.cjs');config.plugins=[];
    config.output={path:scratch,filename:'bundle.js',publicPath:'./'};config.optimization={minimize:false};config.performance={hints:false};
    config.resolve.alias['react-dom/client$']=require.resolve('react-dom/profiling');
    config.module.rules.unshift({test:/\.tsx$/,enforce:'pre',exclude:/node_modules/,use:{loader:path.join(__dirname,'performance-renderer-loader.cjs'),options:{}}});config.module.rules.find(rule=>rule.use?.loader==='ts-loader').use.options.transpileOnly=true;
    await new Promise((resolve,reject)=>require('webpack')(config,(error,stats)=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve()));
    if(metrics.sourceSnapshot(root).sha256!==source.sha256)throw Error('Source changed during profiling build; retry on a fixed source snapshot');
    const bundleSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(scratch,'bundle.js'))).digest('hex');
    const runs=[];
    for(let index=1;index<=options.runs;index++){
      const file=path.join(output,`run-${index}.json`),env={...process.env,HAVVN_BASELINE:JSON.stringify({scratch,output,file,index,options,source:{sha256:source.sha256,head:git.head,bundleSha256},spawnedAt:Date.now()})};delete env.ELECTRON_RUN_AS_NODE;
      console.log(`Performance baseline ${index}/${options.runs}`);
      await new Promise((resolve,reject)=>{const child=cp.spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit'});const timer=setTimeout(()=>child.kill(),180000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Baseline process failed: '+code))})});
      const run=JSON.parse(fs.readFileSync(file,'utf8'));
      if(run.incomplete||JSON.stringify(run.rows.map(row=>row.id))!==JSON.stringify(selected.map(row=>row.id))||run.rows.some(row=>!row.structural.length||row.structural.some(check=>!check.passed)))throw Error('Incomplete or failed baseline result; raw diagnostics preserved');
      runs.push(run);
    }
    if(metrics.sourceSnapshot(root).sha256!==source.sha256)throw Error('Source changed during measurement; results are diagnostic only');
    const summary=metrics.summarize(runs);summary.git=git;
    if(!quick&&options.runs>=3)summary.budgets=metrics.calibrate(summary);
    const reference=option('--compare',null);
    if(reference)summary.comparison={reference,failures:metrics.compare(summary,JSON.parse(fs.readFileSync(path.resolve(reference),'utf8')))};
    write(path.join(output,'summary.json'),summary);
    if(summary.comparison?.failures.length)throw Error('Performance budgets exceeded; summary, raw samples and traces preserved');
    console.log(JSON.stringify({passed:true,runs:runs.length,scenarios:summary.rows.length,output}));
  };
  main().catch(error=>{console.error(error);write(path.join(output,'failure.json'),{at:new Date().toISOString(),error:String(error),stack:error.stack});process.exitCode=1}).finally(cleanup);
}else{
  const {app,BrowserWindow,powerMonitor}=require('electron'),assert=require('node:assert/strict');
  const input=JSON.parse(process.env.HAVVN_BASELINE),{scratch,output,file,index,options,source}=input;
  if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-baseline-'))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'profile-'+index));
  app.on('window-all-closed',()=>{});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let gpuCollector;const gpuSamples=[];let gpuCounterStatus=options.gpu?'waiting for Windows GPU counters':'not requested';
  const deadline=setTimeout(()=>{gpuCollector?.kill();app.exit(1)},170000);
  const startGpuCounters=()=>{
    if(!options.gpu||process.platform!=='win32')return;
    const pidsFile=path.join(scratch,'pids-'+index+'.json');write(pidsFile,[]);
    const command=`$ErrorActionPreference='Stop';try { while($true){${require('./performance-gpu.cjs').gpuPidAssignment(pidsFile)}$rows=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object {$_.Name -match '^pid_([0-9]+)_' -and $ids -contains [int]$Matches[1]} | ForEach-Object {@{name=$_.Name;percent=[double]$_.UtilizationPercentage}});@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();engines=$rows}|ConvertTo-Json -Compress -Depth 4;Start-Sleep -Milliseconds 1000}}catch{@{unavailable=$_.Exception.GetType().Name}|ConvertTo-Json -Compress}`;
    gpuCollector=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let pending='';gpuCollector.stdout.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);try{const sample=JSON.parse(line);if(sample.unavailable)gpuCounterStatus=sample.unavailable;else{if(sample.engines?.length)gpuCounterStatus='Windows GPU engine counters; test PIDs only';else if(!gpuSamples.some(s=>s.engines?.length))gpuCounterStatus='no matching GPU PID rows yet';gpuSamples.push(sample)}}catch{gpuCounterStatus='invalid counter output'}}});
    gpuCollector.on('error',()=>{gpuCounterStatus='counter helper unavailable'});return pidsFile;
  };
  app.whenReady().then(async()=>{
    const startedAt=new Date().toISOString(),electronReadyMs=Date.now()-input.spawnedAt;
    const pidsFile=startGpuCounters(),rows=[],errors=[];
    let powerScheme=null;if(process.platform==='win32')try{powerScheme=cp.execFileSync('powercfg',['/getactivescheme'],{encoding:'utf8',windowsHide:true,timeout:5000}).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0]??null}catch{ /* Power scheme is unavailable on this host. */ }
    const conditions={os:{platform:process.platform,release:os.release(),version:os.version(),arch:process.arch},cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,ramBytes:os.totalmem(),electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,
      onBattery:powerMonitor.isOnBatteryPower(),powerScheme,mode:'production React profiling, unminified; default acceleration; synthetic API; no production backend',windowMode:options.showWindow?'native window':'hidden fixture',nativeVisibility:options.showWindow?options.visibility:'not shown',viewport:[1200,850],effects:'minimal CSS preset; reduced motion; no native DWM bridge',sampleMs:options.sampleMs,warmupMs:options.warmupMs,cycles:options.cycles,gpuCounters:!!options.gpu,resourceMode:options.resourceMode,statsTickMs:options.statsTickMs};
    if(options.visibility!=='visible')conditions.visibility=options.visibility+' (fixture visibilitychange; OS background throttling disabled)';
    for(const dataset of scenarios.filter(row=>!options.scenario||row.id===options.scenario)){
      console.log('Measuring '+dataset.id);const html=path.join(scratch,`case-${index}.html`);
      fs.writeFileSync(html,'<html><meta charset="utf-8"><div id="root"></div><script>window.__perfResourceMode='+JSON.stringify(options.resourceMode)+';window.__perfBaseline='+JSON.stringify(dataset)+'</script><script src="./bundle.js"></script></html>');
      const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
      win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error('Renderer:',event.message)}});
      win.webContents.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!/^(file|data|blob):/.test(details.url)}));
      const run=code=>win.webContents.executeJavaScript(code),until=async code=>{const end=Date.now()+15000;while(!await run(code)){if(Date.now()>end){write(path.join(output,`diagnostic-${index}-${dataset.id}.json`),{waitingFor:code,errors,body:await run('document.body.innerText.slice(0,2000)')});fs.writeFileSync(path.join(output,`diagnostic-${index}-${dataset.id}.png`),(await win.webContents.capturePage()).toPNG());throw Error('UI deadline: '+code)}await wait(25)}};
      if(options.showWindow)win.showInactive();const loadedAt=performance.now();await win.loadFile(html);await until(`!!window.perfResult&&!!document.querySelector('.page-container')&&!document.querySelector('.page-container .page-loading')`);
      const startupMs=performance.now()-loadedAt;
      if(!rows.length){const info=await app.getGPUInfo('basic').catch(()=>null);conditions.graphics=info?.gpuDevice?.map(device=>({vendorId:device.vendorId,deviceId:device.deviceId,driverVersion:device.driverVersion,deviceString:device.deviceString}))??null;}
      assert.equal(powerMonitor.isOnBatteryPower(),conditions.onBattery,'Power source changed during benchmark');
      await until(`document.documentElement.dataset.resourceMode===${JSON.stringify(options.resourceMode)}`);
      await run(`perfAppearance('minimal')`);await wait(options.warmupMs);
      if(!rows.length)conditions.gpuFeatures=app.getGPUFeatureStatus();
      const interactionsMs=[];
      const navigate=async(page)=>{const at=performance.now();await run(`document.querySelector('.pillar-btn:${page==='rooms'?'last':'first'}-child').click()`);await until(page==='rooms'?`!!document.querySelector('.room-workspace')||!!document.querySelector('.room-file')`:`!!document.querySelector('.page-container')`);await run('new Promise(resolve=>setTimeout(()=>setTimeout(resolve,0),0))');interactionsMs.push(performance.now()-at)};
      if(dataset.id==='room-history'){await navigate('rooms');await wait(options.warmupMs)}
      if(options.visibility==='hidden'){if(options.showWindow)win.hide();await run("perfSetVisibility('hidden')");await wait(50)}
      const initial=await run('perfResult()');await run('perfReset()');win.webContents.debugger.attach('1.3');const cdp=(name,params)=>win.webContents.debugger.sendCommand(name,params);
      const processSamples=[],heaps=[],mainLagMs=[];let expected=Date.now()+25,pending=false,lastCpuAt=Date.now();
      const sample=async()=>{if(pending)return;pending=true;try{const span=Date.now()-lastCpuAt;const processes=app.getAppMetrics().map(m=>({pid:m.pid,role:m.type,rawCpuPercent:m.cpu.percentCPUUsage,cpuSpanMs:span,cpuPercent:span>=100&&Number.isFinite(m.cpu.percentCPUUsage)&&m.cpu.percentCPUUsage>=0?m.cpu.percentCPUUsage:null,workingSetKiB:m.memory.workingSetSize,privateKiB:Number.isFinite(m.memory.privateBytes)?m.memory.privateBytes:null}));lastCpuAt=Date.now();processSamples.push(processes);if(pidsFile)write(pidsFile,processes.map(p=>p.pid));heaps.push(await cdp('Runtime.getHeapUsage'))}finally{pending=false}};
      const complete=new Promise(resolve=>{const onMessage=(_event,name,params)=>{if(name==='Tracing.tracingComplete'){win.webContents.debugger.removeListener('message',onMessage);resolve(params)}};win.webContents.debugger.on('message',onMessage)});
      await cdp('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing',transferMode:'ReturnAsStream'});
      const hostStart=os.cpus().map(cpu=>cpu.times);
      app.getAppMetrics();lastCpuAt=Date.now();const begin=Date.now(),timer=setInterval(()=>{const at=Date.now();mainLagMs.push(Math.max(0,at-expected));expected=at+25},25),sampler=setInterval(()=>{void sample().catch(error=>errors.push(String(error)))},500);
      await sample();
      if(dataset.id==='heavy-remount')for(let cycle=0;cycle<options.cycles;cycle++){await navigate('rooms');await navigate('downloads');await sample()}
      else for(let tick=0;tick<Math.ceil(options.sampleMs/options.statsTickMs);tick++){
        const at=performance.now();if(dataset.id==='room-history')await run('perfRoomTick()');else if(dataset.downloads)await run('perfTick()');
        if(dataset.downloads||dataset.id==='room-history'){await run('new Promise(resolve=>setTimeout(()=>setTimeout(resolve,0),0))');interactionsMs.push(performance.now()-at)}await wait(options.statsTickMs);
      }
      await wait(Math.max(0,options.sampleMs-(Date.now()-begin)));
      clearInterval(timer);clearInterval(sampler);while(pending)await wait(10);await sample();const end=Date.now(),ui=await run('perfResult()');
      await cdp('Tracing.end');const {stream}=await complete;let traceText='';for(;;){const chunk=await cdp('IO.read',{handle:stream});traceText+=chunk.data;if(chunk.eof)break}await cdp('IO.close',{handle:stream});
      const trace=JSON.parse(traceText),traceCounts={},traceDurationsMs={};for(const event of trace.traceEvents){if(event.ph==='M')continue;traceCounts[event.name]=(traceCounts[event.name]||0)+1;if(event.dur)traceDurationsMs[event.name]=(traceDurationsMs[event.name]||0)+event.dur/1000}
      const traceFile=`trace-${index}-${dataset.id}.json.gz`;fs.writeFileSync(path.join(output,traceFile),require('node:zlib').gzipSync(traceText));
      const structural=[];const verify=(test,label)=>{structural.push({label,passed:!!test});assert(test,label)};
      const hostDelta=os.cpus().map((cpu,i)=>Object.fromEntries(Object.entries(cpu.times).map(([key,value])=>[key,value-hostStart[i][key]])));
      const hostTotal=hostDelta.reduce((n,times)=>n+Object.values(times).reduce((a,b)=>a+b,0),0),hostIdle=hostDelta.reduce((n,times)=>n+times.idle,0);
      const row={windowState:{visible:win.isVisible(),minimized:win.isMinimized()},id:dataset.id,dataset,startupMs,durationMs:end-begin,measuredAt:{begin,end},interactionsMs,processSamples,heaps,mainLagMs,ui,structural,traceFile,traceCounts,traceDurationsMs,rendererPid:win.webContents.getOSProcessId(),profileCache:rows.length?'warmed runtime/profile; new window':'fresh profile; OS cache not purged',gpuEngines:gpuSamples.filter(sample=>sample.at>=begin&&sample.at<=end),hostCpuBusyPercent:hostTotal?100*(1-hostIdle/hostTotal):null};
      rows.push(row);write(file,{version:1,startedAt,conditions,source,electronReadyMs,rows,errors,incomplete:true});
      verify(ui.listeners===1,dataset.id+': one stats subscription');
      if(dataset.id!=='room-history')verify(ui.rows<=100,dataset.id+': bounded download DOM rows');
      if(dataset.id==='heavy-remount'){
        verify(!await run(`!!document.querySelector('.rooms-page')`),'room screen unmounted');
        const live=Object.entries(ui.subscriptions).filter(([,count])=>count>0),before=Object.entries(initial.subscriptions).filter(([,count])=>count>0);
        verify(JSON.stringify(live.sort())===JSON.stringify(before.sort()),'no subscription accumulation after remounts');
      }
      assert.deepEqual(errors,[]);win.webContents.debugger.detach();win.destroy();
    }
    if(options.gpu&&options.showWindow&&options.visibility==='visible'&&!gpuSamples.some(s=>s.engines?.length))throw Error('GPU counters did not observe any test process');const completeGpuInfo=await app.getGPUInfo('complete').catch(()=>({unavailable:true}));conditions.gpuCounterStatus=gpuCounterStatus;
    const result={version:1,startedAt,endedAt:new Date().toISOString(),conditions,source,electronReadyMs,gpuStatus:app.getGPUFeatureStatus(),gpuInfo:completeGpuInfo,gpuCounterStatus,rows,errors};
    write(file,result);gpuCollector?.kill();clearTimeout(deadline);console.log('Saved '+file);app.exit(0);
  }).catch(error=>{console.error(error);write(file+'.failure.json',{at:new Date().toISOString(),error:String(error),stack:error.stack});gpuCollector?.kill();clearTimeout(deadline);app.exit(1)});
}
