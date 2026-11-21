/* eslint-disable @typescript-eslint/no-require-imports -- Local Node performance fixture. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const metrics=require('./performance-baseline-metrics.cjs'),root=path.resolve(__dirname,'..');
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2))};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(!process.argv.includes('--worker')){
  const output=path.resolve(arg('--output','artifacts/sync-work-performance/before'));
  const options={jobs:Number(arg('--jobs',6)),mib:Number(arg('--size-mib',32)),runs:Number(arg('--runs',3))};
  if(!Number.isInteger(options.jobs)||options.jobs<2||options.jobs>12||!Number.isInteger(options.mib)||options.mib<1||options.mib>128||options.runs<1||options.runs>5)throw Error('Invalid fixture limits');
  (async()=>{
    const source=metrics.sourceSnapshot(root);write(path.join(output,'source-manifest.json'),source);
    const runs=[];
    for(let index=1;index<=options.runs;index++){
      console.log('Sync preparation '+index+'/'+options.runs);
      const result=await new Promise((resolve,reject)=>{
        const child=cp.spawn(process.execPath,[__filename,'--worker'],{env:{...process.env,HAVVN_SYNC_MEASURE:JSON.stringify(options)},windowsHide:true,stdio:['ignore','pipe','pipe']});
        let out='',err='';const timeout=setTimeout(()=>child.kill(),120000);
        child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);
        child.on('close',code=>{clearTimeout(timeout);if(code!==0)reject(Error(err||'Incomplete measurement'));else try{resolve(JSON.parse(out))}catch(error){reject(error)}});
      });
      write(path.join(output,'run-'+index+'.json'),result);runs.push(result);
    }
    if(metrics.sourceSnapshot(root).sha256!==source.sha256)throw Error('Source changed during measurement');
    const sameConditions=runs.every(run=>JSON.stringify(run.conditions)===JSON.stringify(runs[0].conditions));
    const summary={source:source.sha256,options,sameConditions,conditions:runs[0].conditions,
      metrics:Object.fromEntries(Object.keys(runs[0].metrics).map(name=>[name,{...metrics.describe(runs.map(run=>run.metrics[name])),runs:runs.map(run=>run.metrics[name])}]))};
    write(path.join(output,'summary.json'),summary);if(!sameConditions)throw Error('Power or hardware conditions changed; raw diagnostics retained');
    console.log(JSON.stringify(summary.metrics));
  })().catch(error=>{write(path.join(output,'failure.json'),{error:String(error)});console.error(error);process.exitCode=1});
}else{
  (async()=>{
    const options=JSON.parse(process.env.HAVVN_SYNC_MEASURE),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-sync-measure-'));
    const cleanup=async()=>{
      const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('havvn-sync-measure-'))throw Error('Unexpected fixture directory');
      await fs.promises.rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    };
    let timer,probe;
    try{
      const space=fs.statfsSync(scratch);if(space.bavail*space.bsize<options.jobs*options.mib*1048576*4+536870912)throw Error('Insufficient free space for bounded fixture');
      const block=Buffer.alloc(1048576);for(let i=0;i<block.length;i+=32)crypto.createHash('sha256').update('fixture-'+i).digest().copy(block,i);
      const source=path.join(scratch,'source.bin'),fd=fs.openSync(source,'wx');try{for(let i=0;i<options.mib;i++)fs.writeSync(fd,block)}finally{fs.closeSync(fd)}
      const {prepareSyncSnapshot}=require(path.join(root,'dist/electron/electron/sharing/room-sync-snapshot.js'));
      let powerScheme=null;try{powerScheme=cp.execFileSync('powercfg',['/getactivescheme'],{encoding:'utf8',windowsHide:true}).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0]??null}catch{ /* Not a Windows host. */ }
      const conditions={node:process.versions.node,platform:process.platform,cpu:os.cpus()[0].model,powerScheme};
      // Observe actual file streams/copies, not promises waiting outside the queue.
      const originalRead=fs.createReadStream,originalCopy=fs.promises.copyFile;
      let readers=0,peakReaders=0,copies=0,peakCopies=0,peakRss=process.memoryUsage().rss;
      fs.createReadStream=function(...args){const stream=originalRead.apply(this,args);readers++;peakReaders=Math.max(peakReaders,readers);stream.once('close',()=>readers--);return stream};
      fs.promises.copyFile=async function(...args){copies++;peakCopies=Math.max(peakCopies,copies);try{return await originalCopy.apply(this,args)}finally{copies--}};
      const lag=[],reads=[],heartbeat=[];let expected=performance.now()+10,stopped=false,probing=Promise.resolve();
      timer=setInterval(()=>{const now=performance.now();lag.push(Math.max(0,now-expected));expected=now+10;peakRss=Math.max(peakRss,process.memoryUsage().rss)},10);
      const handle=await fs.promises.open(source,'r'),buffer=Buffer.alloc(262144);
      const sample=async()=>{const start=performance.now();await handle.read(buffer,0,buffer.length,0);reads.push(performance.now()-start);heartbeat.push(performance.now());if(!stopped)probe=setTimeout(()=>{probing=sample()},20)};
      probing=sample();await wait(100);
      const started=performance.now(),cpu=process.cpuUsage();
      const snapshots=await Promise.all(Array.from({length:options.jobs},(_,i)=>prepareSyncSnapshot({source,storage:path.join(scratch,'snapshots-'+i),authorId:'fixture',secret:'a'.repeat(64)})));
      const durationMs=performance.now()-started,cpuTime=process.cpuUsage(cpu);
      stopped=true;clearTimeout(probe);await probing;await handle.close();clearInterval(timer);
      for(const snapshot of snapshots){if(snapshot.file.size!==options.mib*1048576||snapshot.plaintextDigest!==snapshots[0].plaintextDigest)throw Error('Corrupt fixture output')}
      const gaps=heartbeat.slice(1).map((at,i)=>at-heartbeat[i]);
      process.stdout.write(JSON.stringify({conditions,metrics:{durationMs,cpuMs:(cpuTime.user+cpuTime.system)/1000,eventLoopP95Ms:metrics.quantile(lag,.95),eventLoopMaxMs:Math.max(...lag),readProbeP95Ms:metrics.quantile(reads,.95),probeGapMaxMs:Math.max(...gaps),peakRssMiB:peakRss/1048576,peakReaders,peakCopies},checks:{snapshots:snapshots.length,readProbes:reads.length,allDigestsEqual:true}}));
    }finally{clearInterval(timer);clearTimeout(probe);await cleanup()}
  })().catch(error=>{console.error(error);process.exitCode=1});
}
