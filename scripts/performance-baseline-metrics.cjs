/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS metrics and source manifest utilities. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const finite = values => values.filter(Number.isFinite);
const quantile = (values, p) => { const sorted = finite(values).sort((a,b)=>a-b); return sorted.length ? sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] : null; };
const mean = values => { const rows=finite(values); return rows.length ? rows.reduce((a,b)=>a+b,0)/rows.length : null; };
const cpuMean = (samples,role) => mean(samples.map(sample=>{const rows=role?sample.filter(p=>p.role===role):sample;return rows.every(p=>Number.isFinite(p.cpuPercent)&&p.cpuPercent>=0)?rows.reduce((n,p)=>n+p.cpuPercent,0):null}));
const describe = values => ({ median:quantile(values,.5), p95:quantile(values,.95), min:quantile(values,0), max:quantile(values,1), samples:finite(values).length });
function sourceSnapshot(root) {
  const files = [];
  function visit(folder) { for(const entry of fs.readdirSync(path.join(root,folder),{withFileTypes:true})) {
    const file=path.posix.join(folder,entry.name);
    if(entry.isDirectory()) visit(file); else if(entry.isFile() && /\.(tsx?|css|json|c?js|mjs)$/.test(file)) files.push(file);
  } }
  for(const folder of ['renderer','shared','electron','scripts']) visit(folder);
  for(const file of ['package.json','package-lock.json','tsconfig.base.json','tsconfig.renderer.json','webpack.renderer.config.js']) files.push(file);
  const hashes=Object.fromEntries(files.sort().map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
  return { sha256:crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), hashes };
}
function summarize(runs) {
  if(!runs.length) throw Error('No completed performance runs');
  const reference=runs[0];
  for(const run of runs) {
    if(run.incomplete||run.errors?.length||run.rows.some(row=>row.structural.some(check=>!check.passed)))throw Error('Incomplete or failed performance run');
    if(run.source.sha256!==reference.source.sha256 || JSON.stringify(run.conditions)!==JSON.stringify(reference.conditions) || JSON.stringify(run.rows.map(row=>row.id))!==JSON.stringify(reference.rows.map(row=>row.id))) throw Error('Mixed source, conditions or scenario order');
  }
  const rows=reference.rows.map((row,index)=>{
    const members=runs.map(run=>run.rows[index]);
    const metric = getter => { const samples=members.map(getter); return { ...describe(samples), runs:samples }; };
    return { id:row.id, dataset:row.dataset,
      metrics:{ startupMs:metric(r=>r.startupMs), interactionP95Ms:metric(r=>quantile(r.interactionsMs,.95)),
        reactCommitP95Ms:metric(r=>quantile(r.ui.commits,.95)), reactCommitCount:metric(r=>r.ui.commits.length), componentRenderCount:metric(r=>r.ui.renders?Object.values(r.ui.renders).reduce((a,b)=>a+b,0):null), rendererLagP95Ms:metric(r=>quantile(r.ui.lag,.95)), mainLagP95Ms:metric(r=>quantile(r.mainLagMs,.95)),
        privateMiB:metric(r=>quantile(r.processSamples.map(sample=>sample.every(p=>p.privateKiB!==null)?sample.reduce((n,p)=>n+p.privateKiB/1024,0):null),.5)),
        rendererHeapMiB:metric(r=>quantile(r.heaps.map(h=>h.usedSize/1048576),.5)), cpuPercent:metric(r=>cpuMean(r.processSamples)),
        syntheticBoundaryKiB:metric(r=>(r.ui.boundary.requestBytes+r.ui.boundary.responseBytes+r.ui.boundary.eventBytes)/1024), domNodes:metric(r=>r.ui.domNodes),
      }, structural:members.map(r=>r.structural),
      trace: Object.fromEntries(['DrawFrame','Paint','UpdateLayoutTree','Layout'].map(name=>[name,describe(members.map(r=>r.traceCounts?.[name]??0))])),
      cpuByRole:Object.fromEntries([...new Set(members.flatMap(r=>r.processSamples.flatMap(sample=>sample.map(p=>p.role))))].map(role=>[role,describe(members.map(r=>cpuMean(r.processSamples,role)))])),
    };
  });
  return { version:1, startedAt:reference.startedAt, endedAt:runs.at(-1).endedAt, runs:runs.length, conditions:reference.conditions, source:reference.source, rows };
}
const floor = {startupMs:250,interactionP95Ms:100,reactCommitP95Ms:10,reactCommitCount:3,componentRenderCount:10,rendererLagP95Ms:20,mainLagP95Ms:20,privateMiB:32,rendererHeapMiB:16,cpuPercent:1,syntheticBoundaryKiB:64,domNodes:100};
function calibrate(summary) {
  if(summary.runs<3) throw Error('At least three repeated runs are required to calibrate budgets');
  return { provisional:true, rule:'max of three run values + max(40% of max, 3 × range, metric floor)', rows:Object.fromEntries(summary.rows.map(row=>[row.id,Object.fromEntries(Object.entries(row.metrics).filter(([,m])=>m.samples===summary.runs).map(([key,m])=>[key,m.max+Math.max(m.max*.4,(m.max-m.min)*3,floor[key])]))])) };
}
function compare(summary,baseline) {
  if(!baseline.budgets) throw Error('Reference has no calibrated budgets');
  // Version-1 references before resource mode always used normal + 750 ms pushes.
  const conditions = value => ({resourceMode:'normal',statsTickMs:750,...value});
  if(JSON.stringify(conditions(summary.conditions))!==JSON.stringify(conditions(baseline.conditions))) throw Error('Comparison conditions differ; recalibrate on this host/mode/data');
  const failures=[];
  for(const row of summary.rows) for(const [metric,limit] of Object.entries(baseline.budgets.rows[row.id]??{})) {
    const value=row.metrics[metric]?.median;
    if(!Number.isFinite(value)) failures.push({scenario:row.id,metric,reason:'unavailable',limit});
    else if(value>limit) failures.push({scenario:row.id,metric,value,limit});
  }
  if(JSON.stringify(summary.rows.map(r=>[r.id,r.dataset]))!==JSON.stringify(baseline.rows.map(r=>[r.id,r.dataset]))) throw Error('Comparison dataset differs');
  return failures;
}
module.exports={quantile,mean,describe,sourceSnapshot,summarize,calibrate,compare};
