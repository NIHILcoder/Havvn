/* eslint-disable @typescript-eslint/no-require-imports -- Isolated DPAPI/process-crash acceptance, never the user profile. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-device-vault-'));
  const launch=(stage,expected=0)=>new Promise((resolve,reject)=>{const env={...process.env,HAVVN_DEVICE_VAULT_TEST:scratch,HAVVN_DEVICE_VAULT_STAGE:stage};delete env.ELECTRON_RUN_AS_NODE;
    const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===expected?resolve():reject(Error('Device vault stage failed: '+stage)));});
  (async()=>{try{await launch('seed');await launch('crash-after-commit',29);await launch('recover-and-revoke');await launch('verify-revoked');}finally{const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('havvn-device-vault-')){console.error('Unexpected profile; cleanup skipped');process.exitCode=1;}else fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}})().catch(error=>{console.error(error);process.exitCode=1;});
}else{
  const {app,safeStorage}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_DEVICE_VAULT_TEST||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-device-vault-'))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'profile'));app.disableHardwareAcceleration();
  const deadline=setTimeout(()=>{console.error('Device vault deadline');app.exit(1);},45000);
  app.whenReady().then(async()=>{
    const stage=process.env.HAVVN_DEVICE_VAULT_STAGE,output=path.join(root,'artifacts/dp01'),reportPath=path.join(output,'native.json');fs.mkdirSync(output,{recursive:true});
    const checks=[],check=(condition,name)=>{assert(condition,name);checks.push(name);console.log('PASS '+name);};
    const {openDeviceVault}=require(path.join(root,'dist/electron/electron/devices/runtime.js'));
    const {certificateHash}=require(path.join(root,'dist/electron/electron/devices/identity.js'));
    const aDir=path.join(app.getPath('userData'),'a'),bDir=path.join(app.getPath('userData'),'b'),factsFile=path.join(scratch,'facts.json'),stateFile=path.join(aDir,'device-state.json');
    const finish=()=>{const report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath)): {schema:1,physicalMachines:1,electron:process.versions.electron,node:process.versions.node,openssl:process.versions.openssl,osProtection:true,tlsNetworkTested:false,channelBinding:'synthetic test input; no live TLS connection',installerTested:false,stages:{}};
      report.stages[stage]={passed:true,checks};report.passed=stage==='verify-revoked';report.at=new Date().toISOString();fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');clearTimeout(deadline);app.exit(0);};
    check(safeStorage.isEncryptionAvailable(),'real OS protection is available');
    if(stage==='seed'){
      if(fs.existsSync(reportPath))fs.unlinkSync(reportPath);
      await assert.rejects(openDeviceVault({directory:aDir,initialize:true}),/state/);check(true,'runtime requires the main-process single-instance lock');
    }
    if(!app.requestSingleInstanceLock())throw Error('Isolated instance lock unavailable');
    if(stage==='seed'){
      await assert.rejects(openDeviceVault({directory:path.join(scratch,'outside-profile'),initialize:true}),/clone/);check(!fs.existsSync(path.join(scratch,'outside-profile')),'runtime cannot bypass profile ownership with an arbitrary directory');
      const a=await openDeviceVault({directory:aDir,initialize:true}),b=await openDeviceVault({directory:bDir,initialize:true}),pa=a.publicIdentity(),pb=b.publicIdentity();
      check(pa.deviceId!==pb.deviceId,'two independent native identities and certificates');check(!!a.createTlsContext(),'OpenSSL accepts the generated key/certificate');
      const invite=await a.issueInvitation({host:'127.0.0.1',port:47474},['preferences','views','playback']);
      const body={version:1,role:'responder',inviteId:invite.inviteId,pairId:invite.pairId,grantId:invite.grantId,initiatorId:pa.deviceId,responderId:pb.deviceId,initiatorCertificate:certificateHash(pa),responderCertificate:certificateHash(pb),scopes:invite.scopes,challengeA:crypto.randomBytes(32).toString('hex'),challengeB:crypto.randomBytes(32).toString('hex'),channelBinding:crypto.randomBytes(32).toString('hex')};
      await b.acceptInvitation(invite,body);const proofB=await b.approveLocal();await a.bindInvitation(invite.inviteId,invite.token,pb,proofB);
      check(a.snapshot().status==='pending'&&b.snapshot().status==='pending','one local approval never activates a pair');
      const proofA=await a.approveLocal();await b.recordPeerProof(proofA);const readyA=a.preparedReceipt(),readyB=b.preparedReceipt();await a.activate(readyB);await b.activate(readyA);
      check(a.snapshot().status==='active'&&b.snapshot().status==='active','both signed approvals and prepared receipts commit active state');
      const operation=await a.enqueue('preferences','language','ru');
      const raw=fs.readFileSync(stateFile,'utf8');check(!raw.includes('PRIVATE KEY')&&!raw.includes(invite.token)&&!raw.includes('"language"'),'real DPAPI file exposes no key, invitation token or queued value');
      const publicJson=JSON.stringify(a.snapshot());check(!/privateKey|token|channelBinding|certificate/.test(publicJson),'public snapshot excludes credential material');
      await a.close();await b.close();const clone=path.join(app.getPath('userData'),'cloned-a');fs.mkdirSync(clone);for(const name of fs.readdirSync(aDir))fs.copyFileSync(path.join(aDir,name),path.join(clone,name));
      const before=crypto.createHash('sha256').update(fs.readFileSync(path.join(clone,'device-state.json'))).digest('hex');await assert.rejects(openDeviceVault({directory:clone}),/clone/);
      check(crypto.createHash('sha256').update(fs.readFileSync(path.join(clone,'device-state.json'))).digest('hex')===before,'copied profile is rejected without replacing its identity');
      check(!fs.existsSync(path.join(app.getPath('userData'),'rooms.json')),'room identity store is never created or copied');
      fs.writeFileSync(factsFile,JSON.stringify({a:pa.deviceId,b:pb.deviceId,operation,readyB}));finish();return;
    }
    const facts=JSON.parse(fs.readFileSync(factsFile));const a=await openDeviceVault({directory:aDir});
    check(a.publicIdentity().deviceId===facts.a,'the protected identity survives a fresh Electron process');
    if(stage==='crash-after-commit'){
      const op=await a.enqueue('preferences','density','compact');check(op.sequence===2,'second operation is durably committed before abrupt exit');
      // Deliberately no graceful close and no caller/network acknowledgment.
      const report=JSON.parse(fs.readFileSync(reportPath));report.stages[stage]={passed:true,expectedExit:29,checks};fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');process.exit(29);
    }
    if(stage==='recover-and-revoke'){
      check(a.snapshot().counters.preferences===2&&a.outbound().length===2,'abrupt exit retains both counter and unacknowledged operations');
      const selected=a.outbound()[0],before=crypto.createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex'),rename=fs.renameSync;
      fs.renameSync=(from,to)=>{if(String(to)===stateFile)throw Object.assign(Error('Injected isolated publish failure'),{code:'EACCES'});return rename(from,to);};
      try{await assert.rejects(a.revoke(),/storage/);}finally{fs.renameSync=rename;}
      check(a.snapshot().status==='paused-error'&&crypto.createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex')===before,'failed atomic publication preserves ciphertext and freezes output');
      assert.throws(()=>a.guardOutbound(selected),/state/);check(true,'a selected packet cannot escape after failed revocation');
      check(!fs.readdirSync(aDir).some(name=>name.endsWith('.tmp')),'failed publication cleans its encrypted temporary file');
      await a.revoke();const revision=a.snapshot().revision;await a.revoke();
      check(a.snapshot().status==='revoked'&&a.snapshot().outbox===0&&a.snapshot().revision===revision,'revocation retry persists a tombstone and exact repeats do not write again');
      await a.close();finish();return;
    }
    check(a.snapshot().status==='revoked'&&a.snapshot().outbox===0,'revocation survives another native process restart');
    assert.throws(()=>a.guardOutbound(facts.operation),/state/);await assert.rejects(a.activate(facts.readyB),/not-confirmed/);
    check(true,'old queue entries and signed ready receipts cannot reactivate the revoked grant');
    await a.close();finish();
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
