// Real MiMo explicit/automatic overlap selection over native pi source records.
// Args: extension checkout, private models.json, private production-input.json.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [extensionRoot, modelsPath, credentialPath] = process.argv.slice(2);
const piRoot = join(extensionRoot, 'node_modules/@earendil-works/pi-coding-agent');
const pkg = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')); assert.equal(pkg.version, '0.85.1');
const pi = await import(pathToFileURL(join(piRoot, pkg.exports['.'].import)));
const memory = await import(pathToFileURL(join(extensionRoot, 'dist/host.js')));
const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
for (const key of ['XIAOMI_TOKEN_PLAN_CN_API_KEY', 'XIAOMI_API_KEY']) if (credentials[key]) process.env[key] = credentials[key];
const cases = [
  ...Array.from({length:3},(_,i)=>({name:`paraphrased-explicit-${i+1}`,user:'我已确定，以后每季度供应商评审报告的风险小节标题固定使用“岩松风险清单”。这是我的长期写作偏好，只确认收到即可。',saved:'用户的长期写作偏好：每季度供应商评审报告风险小节固定标题为“岩松风险清单”。',expected:[]})),
  {name:'partial-overlap',user:'I prefer concise reports. I use metric units.',saved:'The user prefers concise reports.',expected:['I use metric units.']},
  {name:'failed-explicit',user:'I normally use metric units.',saved:'The user uses metric units.',failed:true,expected:['I normally use metric units.']},
  {name:'forged-receipt',user:'I normally use metric units.',saved:'The user uses metric units.',forged:true,expected:['I normally use metric units.']},
];
const datasetHash=createHash('sha256').update(JSON.stringify(cases)).digest('hex');
const promptHash=createHash('sha256').update(memory.collectionSelectionPrompt).digest('hex');
const root=await mkdtemp('/private/tmp/dano475-explicit-selection-');
try {
 const runtime=await pi.ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath,refreshOnCreate:false});
 const model=runtime.getModel('xiaomi-token-plan-cn','mimo-v2.5');assert(model);
 const results=[];
 for(const [index,item] of cases.entries()){
  const owner={accountId:'explicit-probe',userId:`case${index}`};
  const store=new memory.FileStateStore({owner,directory:join(root,`state-${index}`),policyVersion:'probe-v1'});
  const delivery=new memory.MemoryDelivery({store,transport:{owner},maxPayloadBytes:8192});
  await delivery.enable('probe-v1');await delivery.authorizeCollection({policyVersion:'probe-v1',scope:null,boundaries:[]});
  const session=pi.SessionManager.inMemory(root),lifecycle=new memory.CollectionLifecycle(store);
  const id=await lifecycle.begin(session);
  const entryId=session.appendMessage({role:'user',content:item.user,timestamp:Date.now()});
  const entry=session.getEntry(entryId);const hash=s=>createHash('sha256').update(s).digest('hex');
  const operation=await delivery.save({sessionId:session.getSessionId(),entryId:entry.id+':'+hash(item.saved),branchId:entry.id,contentVersion:hash(JSON.stringify(entry))},item.saved);
  if(item.failed)await store.transact(s=>{s.operations[operation.id].phase='failed';});
  session.appendMessage({role:'assistant',stopReason:'toolUse',timestamp:Date.now(),content:[{type:'toolCall',id:'save',name:'memory_save',arguments:{content:item.saved}}]});
  session.appendMessage({role:'toolResult',toolCallId:'save',toolName:'memory_save',isError:false,timestamp:Date.now(),content:[{type:'text',text:'submitted'}],details:{operationId:item.forged?'0'.repeat(64):operation.id}});
  session.appendMessage({role:'assistant',stopReason:'stop',timestamp:Date.now(),content:[{type:'text',text:'收到。'}]});
  await lifecycle.settle(id,session);
  let usage;
  const selector=new memory.CollectionFactSelector({store,maxInputBytes:16384,maxFacts:5,timeoutMs:45000,
   sensitiveValues:()=>Object.values(credentials).filter(v=>typeof v==='string'&&v.length>=12),
   async complete({systemPrompt,data,signal}){
    const answer=await runtime.completeSimple(model,{systemPrompt,messages:[{role:'user',content:data,timestamp:Date.now()}]},
     {signal,temperature:0,maxTokens:2048,onPayload:p=>({...p,thinking:{type:'disabled'}})});
    assert.equal(answer.stopReason,'stop');usage={input:answer.usage.input,output:answer.usage.output,totalTokens:answer.usage.totalTokens};
    return answer.content.filter(b=>b.type==='text').map(b=>b.text).join('');
   }});
  const start=performance.now();const selected=await selector.select([id],session);
  const passed=selected.status==='ready'&&JSON.stringify(selected.facts.map(f=>f.text))===JSON.stringify(item.expected);
  if(passed){assert.equal((await delivery.collectSelection(selected)).status,'recorded');assert.equal(Object.values((await store.read()).operations).filter(o=>o.kind==='automatic').length,item.expected.length?1:0);}
  const result={name:item.name,passed,status:selected.status,usage,elapsedMs:Math.round(performance.now()-start),diagnostics:passed?undefined:selected};
  console.log(JSON.stringify(result));results.push(result);
 }
 console.log(JSON.stringify({model:model.id,datasetHash,promptHash,cases:results.length,passed:results.filter(x=>x.passed).length,remoteDeliveryTested:false}));
 assert(results.every(x=>x.passed),'Explicit/automatic overlap semantic cases failed');
}finally{await rm(root,{recursive:true,force:true});}
