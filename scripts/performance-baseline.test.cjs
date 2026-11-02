/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner exercises the CommonJS metrics. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {quantile,describe,summarize,calibrate,compare}=require('./performance-baseline-metrics.cjs');
test('Windows GPU collector keeps decoded PID array elements searchable', {skip:process.platform!=='win32'},()=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-gpu-pids-')),file=path.join(folder,'pids.json');
  try {
    fs.writeFileSync(file,JSON.stringify([123,456]));
    const command=require('./performance-gpu.cjs').gpuPidAssignment(file)+"@{count=$ids.Count;found=($ids -contains 123);missing=($ids -contains 789)}|ConvertTo-Json -Compress";
    const result=JSON.parse(cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true}));
    assert.deepEqual(result,{count:2,found:true,missing:false});
  } finally { fs.unlinkSync(file); fs.rmdirSync(folder); }
});
test('invalid CPU counters are unavailable, not negative usage or invented zero',()=>{for(const value of [-1,null,NaN]){const fixture=run();fixture.rows[0].processSamples[0][0].cpuPercent=value;assert.equal(summarize([fixture]).rows[0].metrics.cpuPercent.median,null)}});
test('partial runs and failed structural assertions cannot become a passing summary',()=>{assert.throws(()=>summarize([{...run(),incomplete:true}]),/Incomplete/);const broken=run();broken.rows[0].structural.push({passed:false});assert.throws(()=>summarize([broken]),/failed/)});
function run(value=10){return {startedAt:'2026-10-25',endedAt:'2026-10-25',conditions:{host:'fixture'},source:{sha256:'same'},rows:[{id:'fixture',dataset:{downloads:100},startupMs:value,interactionsMs:[value],ui:{commits:[value],lag:[value],boundary:{requestBytes:0,responseBytes:0,eventBytes:0},domNodes:10},mainLagMs:[value],processSamples:[[{privateKiB:1024,cpuPercent:.1}]],heaps:[{usedSize:1048576}],structural:[]} ]}}
test('nearest-rank statistics retain measured zero and unavailable separately',()=>{assert.equal(quantile([NaN,null],.5),null);assert.equal(quantile([0,1,2,3],.95),3);assert.equal(describe([0]).median,0)});
test('summary rejects changing source and conditions within a repeat series',()=>{assert.throws(()=>summarize([run(),{...run(),source:{sha256:'changed'}}]),/Mixed/);assert.throws(()=>summarize([run(),{...run(),conditions:{host:'other'}}]),/Mixed/)});
test('calibration requires repeats and includes actual observed spread',()=>{assert.throws(()=>calibrate(summarize([run()])),/three/);const summary=summarize([run(10),run(20),run(30)]);assert.equal(summary.rows[0].metrics.startupMs.median,20);assert.equal(calibrate(summary).rows.fixture.startupMs,280)});
test('comparison accepts code changes, refuses unlike conditions, and reports an overrun',()=>{const baseline=summarize([run(),run(),run()]);baseline.budgets=calibrate(baseline);const candidate=summarize([run(1000)]);candidate.source.sha256='changed';assert(compare(candidate,baseline).some(row=>row.metric==='startupMs'));candidate.conditions.host='other';assert.throws(()=>compare(candidate,baseline),/conditions/)});
test('unknown memory is not reported as zero',()=>{const fixture=run();fixture.rows[0].processSamples[0][0].privateKiB=null;assert.equal(summarize([fixture]).rows[0].metrics.privateMiB.median,null)});
test('quick runs cannot silently recalibrate a regression away',()=>{const baseline=summarize([run(),run(),run()]);baseline.budgets=calibrate(baseline);const candidate=summarize([run(1000)]);const before=JSON.stringify(baseline.budgets);assert(compare(candidate,baseline).length>0);assert.equal(JSON.stringify(baseline.budgets),before)});
test('old references retain normal 750ms semantics while economy and changed cadence cannot pass as equivalent',()=>{
  const baseline=summarize([run(),run(),run()]);baseline.budgets=calibrate(baseline);
  const candidate=summarize([run()]);candidate.conditions={...candidate.conditions,resourceMode:'normal',statsTickMs:750};
  assert.deepEqual(compare(candidate,baseline),[]);
  candidate.conditions.resourceMode='economy';assert.throws(()=>compare(candidate,baseline),/conditions/);
  candidate.conditions.resourceMode='normal';candidate.conditions.statsTickMs=100;assert.throws(()=>compare(candidate,baseline),/conditions/);
});
test('a hidden UI series cannot be compared with foreground budgets',()=>{
  const baseline=summarize([run(),run(),run()]);baseline.budgets=calibrate(baseline);
  const candidate=summarize([run()]);candidate.conditions.visibility='hidden (fixture visibilitychange; OS background throttling disabled)';
  assert.throws(()=>compare(candidate,baseline),/conditions/);
});
