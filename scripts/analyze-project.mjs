import {GooglePauseError} from './google-api.mjs';
import {appendFile} from 'node:fs/promises';
import {jsonFile,listPaths,readJson,readText,StoragePauseError,uploadWithRetry} from './hf-pipeline.mjs';
import {compactBatches,createQuotaRouter} from './quota-control.mjs';
import {detectColumns,parseDelimited} from './tabular.mjs';

const required=['PROJECT_ID','RUN_ID','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;const runId=process.env.RUN_ID;const statusPath=`status/${projectId}/analysis.json`;
const statusFile=(status,extra={})=>jsonFile(statusPath,{runId,status,updatedAt:new Date().toISOString(),...extra});
const setReady=async value=>{if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`ready=${value?'true':'false'}\n`)};
const normalizedCategory=value=>/menu/i.test(value)?'menu':/interact/i.test(value)?'interaction':'story';
function parsedArray(payload){const raw=String(payload?.candidates?.[0]?.content?.parts?.[0]?.text||'');const start=raw.indexOf('[');const end=raw.lastIndexOf(']');if(start<0||end<start)throw new Error('Google AI did not return an analysis array');const value=JSON.parse(raw.slice(start,end+1));if(!Array.isArray(value))throw new Error('Google AI analysis is not an array');return value}
async function readMany(paths){const values=[];for(let offset=0;offset<paths.length;offset+=12)values.push(...await Promise.all(paths.slice(offset,offset+12).map(path=>readJson(path))));return values}

async function main(){
  try{
    const manifest=await readJson(`queues/${projectId}/${runId}/manifest.json`);if(!manifest)throw new Error('Coordinator manifest not found');const googleModel=manifest.model||process.env.GEMINI_MODEL||'gemini-3.6-flash';
    const projects=await readJson('projects.json');const project=projects?.find(item=>item.id===projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
    const source=await readText(`projects/${project.id}/${project.fileName}`);if(source===null)throw new Error('Source file not found');const rows=parseDelimited(source,manifest.delimiter);const columns=detectColumns(rows);const dataRows=rows.slice(1);const items=dataRows.map((row,index)=>({id:index+1,index,text:String(row[columns.source]||'')}));
    const config=manifest.googleConfig||await readJson('config/google-ai.json')||{model:googleModel};const router=await createQuotaRouter({config,primary:googleModel});
    const paths=await listPaths(`checkpoints/${projectId}/analysis/`);const records=await readMany(paths);const entries=new Map();
    for(const record of records)if(record?.sourceHash===manifest.sourceHash)for(const item of record.entries||[])if(Number(item.id)>0)entries.set(Number(item.id),item);
    let pending=items.filter(item=>!entries.has(item.id));let queue=compactBatches(pending,{tokenBudget:router.batchTokenBudget(),maxRows:router.batchRowLimit(400),serialize:item=>`${item.id}\t${item.text}`});
    await uploadWithRetry([statusFile('running',{model:googleModel,processedRows:entries.size,totalRows:items.length,batches:queue.length,message:'Đang phân loại và tạo thuật ngữ cố định'})]);
    while(queue.length){
      const batch=queue.shift();const compact=batch.map(item=>`${item.id}\t${item.text.replace(/[\r\n\t]+/g,' ')}`).join('\n');
      const prompt=`Analyze these game localization strings before translation from ${project.sourceLanguage} to ${project.targetLanguage}. Input is compact TSV: ID<TAB>ENG. Classify each row as MENU, INTERACTION, or STORY. Extract only reusable terms, proper names, locations, item names, or UI phrases that should stay consistent. Propose a concise Vietnamese target for each extracted term. Do not translate the full sentence.
Return JSON only: [{"id":1,"category":"MENU","terms":[{"source":"COLLECTION","target":"BỘ SƯU TẬP","type":"ui"}]}]. Return every ID exactly once. No Markdown.

ID\tENG
${compact}`;
      try{
        const response=await router.generate({prompt,temperature:.05,label:'Google AI classification and terms'});const parsed=parsedArray(response.payload);const ids=new Set(batch.map(item=>item.id));let accepted=0;
        const batchEntries=[];for(const item of parsed){const id=Number(item.id);if(!ids.has(id))continue;const entry={id,category:normalizedCategory(item.category),terms:(Array.isArray(item.terms)?item.terms:[]).map(term=>typeof term==='string'?{source:term,target:'',type:'term'}:{source:String(term?.source||''),target:String(term?.target||''),type:String(term?.type||'term')}).filter(term=>term.source.trim()).slice(0,8)};entries.set(id,entry);batchEntries.push(entry);accepted+=1}
        if(!accepted)throw new Error('Google AI returned no valid analysis rows');
        const complete=accepted===batch.length;const name=`analysis-${String(batch[0].id).padStart(6,'0')}-${String(batch.at(-1).id).padStart(6,'0')}.json`;await uploadWithRetry([jsonFile(`checkpoints/${projectId}/analysis/${name}`,{version:1,projectId,runId,sourceHash:manifest.sourceHash,model:response.model,entries:batchEntries,complete,updatedAt:new Date().toISOString()}),...router.files(),statusFile('running',{model:response.model,processedRows:entries.size,totalRows:items.length,message:`Đã phân loại ${entries.size}/${items.length} dòng`})]);
        const missing=batch.filter(item=>!entries.has(item.id));if(missing.length)queue.unshift(...compactBatches(missing,{tokenBudget:Math.max(500,Math.floor(router.batchTokenBudget()/2)),maxRows:Math.max(10,Math.min(router.batchRowLimit(),Math.floor(batch.length/2))),serialize:item=>`${item.id}\t${item.text}`}));
      }catch(error){
        if(batch.length>10&&(!(error instanceof GooglePauseError)||error.reason==='batch_too_large')){const middle=Math.ceil(batch.length/2);console.warn(`Analysis batch ${batch.length} rows was not accepted; retrying as ${middle} + ${batch.length-middle}.`);queue.unshift(batch.slice(middle),batch.slice(0,middle));continue}
        const pausedAt=new Date().toISOString();await uploadWithRetry([...router.files(),statusFile('paused',{model:error.model||googleModel,processedRows:entries.size,totalRows:items.length,pauseReason:error.reason||'invalid_response',message:error.message,pausedAt}),...(error.quota?[jsonFile(`status/${projectId}/quota.json`,{runId,model:error.model||googleModel,reason:error.reason||'rate_limit',quota:error.quota,message:error.message,pausedAt,stage:'analysis'})]:[])]);await setReady(false);console.warn(error.message);return;
      }
    }
    const termMap=new Map();for(const entry of entries.values())for(const term of entry.terms||[]){const sourceTerm=String(term.source||'').trim();if(!sourceTerm)continue;const key=sourceTerm.toLocaleLowerCase('en');const current=termMap.get(key)||{source:sourceTerm,category:entry.category,type:term.type||'term',targets:new Map(),examples:[]};const target=String(term.target||'').trim();if(target)current.targets.set(target,(current.targets.get(target)||0)+1);const example=items[entry.id-1]?.text;if(example&&!current.examples.includes(example)&&current.examples.length<3)current.examples.push(example);termMap.set(key,current)}
    const terms=[...termMap.values()].map(item=>({source:item.source,target:[...item.targets].sort((a,b)=>b[1]-a[1])[0]?.[0]||'',category:item.category,type:item.type,examples:item.examples})).sort((a,b)=>a.source.localeCompare(b.source));const categories=[...entries.values()].sort((a,b)=>a.id-b.id).map(item=>({id:item.id,category:item.category}));const completedAt=new Date().toISOString();
    await uploadWithRetry([jsonFile(`glossaries/${projectId}.json`,{version:1,projectId,runId,sourceHash:manifest.sourceHash,model:googleModel,fixed:true,categories,terms,completedAt}),...router.files(),statusFile('completed',{model:googleModel,processedRows:items.length,totalRows:items.length,termCount:terms.length,completedAt,message:`Đã cố định ${terms.length} thuật ngữ`})]);await setReady(true);console.log(`Analyzed ${items.length} rows and fixed ${terms.length} glossary terms`);
  }catch(error){if(error instanceof StoragePauseError){console.warn(error.message);return}try{await uploadWithRetry([statusFile('failed',{error:error.message,failedAt:new Date().toISOString()})])}catch{}throw error}
}

await main();
