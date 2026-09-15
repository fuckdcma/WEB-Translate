import {assertCompleteGooglePayload,GooglePauseError,GoogleResponseError} from './google-api.mjs';
import {appendFile} from 'node:fs/promises';
import {jsonFile,listPaths,readJson,readText,StoragePauseError,uploadWithRetry} from './hf-pipeline.mjs';
import {createQuotaRouter,estimatedTokens,tokenBatchPlan} from './quota-control.mjs';
import {detectColumns,parseDelimited} from './tabular.mjs';

const required=['PROJECT_ID','RUN_ID','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;const runId=process.env.RUN_ID;const statusPath=`status/${projectId}/worker-0.json`;
const workerStatus=(status,extra={})=>jsonFile(statusPath,{runId,index:0,status,updatedAt:new Date().toISOString(),...extra});
const setReady=async value=>{if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`ready=${value?'true':'false'}\n`)};
const taskPath=(task,complete)=>`checkpoints/${projectId}/${complete?'tasks':'partial'}/${task.id}.json`;
const normalizedCategory=value=>/menu/i.test(value)?'menu':/interact/i.test(value)?'interaction':'story';
function parsedArray(payload){assertCompleteGooglePayload(payload,'Google AI translation');const raw=String(payload?.candidates?.[0]?.content?.parts?.[0]?.text||'');const start=raw.indexOf('[');const end=raw.lastIndexOf(']');if(start<0||end<start)throw new GoogleResponseError('Google AI translation trả về dữ liệu không hoàn chỉnh. Tiến độ đã được lưu.',{responseChars:raw.length});try{const value=JSON.parse(raw.slice(start,end+1));if(!Array.isArray(value))throw new Error('not an array');return value}catch{throw new GoogleResponseError('Google AI translation trả về JSON không hợp lệ. Tiến độ đã được lưu.',{responseChars:raw.length})}}
const translationPlan=(items,router)=>tokenBatchPlan(items,{tokenBudget:router.batchTokenBudget(),outputTokenBudget:router.batchOutputTokenBudget(),maxRows:router.batchRowLimit(600),serialize:item=>`${item.id}\t${item.category}\t${item.text}`,estimateOutputTokens:item=>Math.ceil(estimatedTokens(item.text)*1.6)+12});
const canSplit=error=>['batch_too_large','output_limit'].includes(error?.reason);
async function readMany(paths){const values=[];for(let offset=0;offset<paths.length;offset+=12)values.push(...await Promise.all(paths.slice(offset,offset+12).map(path=>readJson(path))));return values}

async function main(){
  try{
    const manifest=await readJson(`queues/${projectId}/${runId}/manifest.json`);if(!manifest)throw new Error('Coordinator manifest not found');const primaryModel=manifest.model||process.env.GEMINI_MODEL||'gemini-3.6-flash';
    const projects=await readJson('projects.json');const project=projects?.find(item=>item.id===projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
    const source=await readText(`projects/${project.id}/${project.fileName}`);if(source===null)throw new Error('Source file not found');const rows=parseDelimited(source,manifest.delimiter);const columns=detectColumns(rows);const dataRows=rows.slice(1);const skippedIndexes=new Set(dataRows.map((row,index)=>String(row[columns.source]||'').trim()?null:index).filter(index=>index!==null));
    const glossary=await readJson(`glossaries/${projectId}.json`);if(!glossary?.fixed||glossary.sourceHash!==manifest.sourceHash){await uploadWithRetry([workerStatus('paused',{model:primaryModel,processedRows:0,totalRows:dataRows.length,pauseReason:'analysis_incomplete',message:'Đang chờ hoàn tất phân loại và glossary.',pausedAt:new Date().toISOString()})]);await setReady(false);console.log('Translation deferred: analysis checkpoint is not complete.');return}
    const config=manifest.googleConfig||await readJson('config/google-ai.json')||{model:primaryModel};const router=await createQuotaRouter({config,primary:primaryModel});const categoryByIndex=new Map((glossary.categories||[]).map(item=>[Number(item.id)-1,normalizedCategory(item.category)]));
    const checkpointPaths=await listPaths(`checkpoints/${projectId}/`);const completedTaskIds=new Set(checkpointPaths.filter(path=>/\/tasks\/[^/]+\.json$/i.test(path)).map(path=>path.split('/').at(-1).replace(/\.json$/i,'')));const translationPaths=checkpointPaths.filter(path=>/\/(tasks|partial)\/[^/]+\.json$/i.test(path)).sort((a,b)=>Number(a.includes('/tasks/'))-Number(b.includes('/tasks/')));const records=await readMany(translationPaths);const translations=new Map();
    for(const record of records)if(record?.sourceHash===manifest.sourceHash)for(const item of record.translations||[])if(String(item.translation||'').trim())translations.set(Number(item.index),String(item.translation));
    const extension=manifest.delimiter===','?'csv':'tsv';const manualContent=await readText(`results/${project.id}/final.${extension}`);if(manualContent){const manualRows=parseDelimited(manualContent,manifest.delimiter);const manualColumns=detectColumns(manualRows);manualRows.slice(1).forEach((row,index)=>{if(String(row[manualColumns.target]||'').trim())translations.set(index,String(row[manualColumns.target]))})}
    const taskByIndex=new Map();for(const task of manifest.tasks)for(const index of task.rowIndexes)taskByIndex.set(index,task);const taskFile=(task,model,now)=>{const taskTranslations=task.rowIndexes.map(index=>({index,translation:String(translations.get(index)||''),...(skippedIndexes.has(index)?{skipped:true}:{})}));const complete=task.rowIndexes.every(index=>skippedIndexes.has(index)||translations.has(index));return jsonFile(taskPath(task,complete),{version:3,projectId,runId,sourceHash:manifest.sourceHash,taskId:task.id,category:task.category,model,rowIndexes:task.rowIndexes,translations:taskTranslations,complete,updatedAt:now,...(complete?{completedAt:now}:{})})};
    const pending=dataRows.map((row,index)=>({id:index+1,index,text:String(row[columns.source]||''),category:categoryByIndex.get(index)||'story'})).filter(item=>!skippedIndexes.has(item.index)&&!translations.has(item.index));
    const plan=translationPlan(pending,router);const queue=[...plan.batches];
    const progress=()=>({processedRows:translations.size+skippedIndexes.size,translatedRows:translations.size,skippedRows:skippedIndexes.size,totalRows:dataRows.length,completedTasks:manifest.tasks.filter(task=>task.rowIndexes.every(index=>skippedIndexes.has(index)||translations.has(index))).length,totalTasks:manifest.tasks.length});const startedAt=new Date().toISOString();const migrated=manifest.tasks.filter(task=>!completedTaskIds.has(task.id)&&task.rowIndexes.every(index=>skippedIndexes.has(index)||translations.has(index))).map(task=>taskFile(task,primaryModel,startedAt));
    await uploadWithRetry([...migrated,workerStatus('running',{model:primaryModel,...progress(),queuedBatches:queue.length,plannedBatches:plan.batchCount,pendingTokens:plan.totalTokens,estimatedOutputTokens:plan.totalOutputTokens,tokenBudget:plan.tokenBudget,outputTokenBudget:plan.outputTokenBudget,message:`Đã chia ${plan.totalTokens.toLocaleString('vi-VN')} token thành ${plan.batchCount} lô an toàn theo cả đầu vào và đầu ra`})]);
    while(queue.length){
      const batch=queue.shift();const compact=batch.map(item=>`${item.id}\t${item.category.toUpperCase()}\t${item.text.replace(/[\r\n\t]+/g,' ')}`).join('\n');const joined=batch.map(item=>item.text.toLocaleLowerCase()).join('\n');const relevant=(glossary.terms||[]).filter(term=>term.source&&joined.includes(String(term.source).toLocaleLowerCase())).slice(0,120).map(term=>`${term.source}=${term.target}`).join('; ');
      const prompt=`Translate this compact game localization batch from ${project.sourceLanguage} to ${project.targetLanguage}. Input is ID<TAB>CATEGORY<TAB>ENG. Return only the Vietnamese text for each ID. Use CATEGORY to preserve the correct menu, interaction, or story tone. Preserve placeholders, tags, variables, proper names, line breaks represented inside text, and capitalization where meaningful. Follow the fixed glossary exactly when a listed term appears. Keep pronouns and tone consistent.
Fixed glossary: ${relevant||'(no matching fixed terms)'}
Return JSON only: [{"id":1,"vi":"..."}]. Return every ID exactly once. No Markdown.

ID\tCATEGORY\tENG
${compact}`;
      try{
        const response=await router.generate({prompt,temperature:.15,label:'Google AI translation'});const parsed=parsedArray(response.payload);const ids=new Set(batch.map(item=>item.id));const accepted=[];
        for(const item of parsed){const id=Number(item.id);const value=String(item.vi??item.translation??'').trim();if(!ids.has(id)||!value)continue;const index=id-1;translations.set(index,value);accepted.push(index)}
        if(!accepted.length)throw new Error('Google AI returned no valid translations');
        const touched=[...new Set(accepted.map(index=>taskByIndex.get(index)).filter(Boolean))];const files=[];const now=new Date().toISOString();for(const task of touched)files.push(taskFile(task,response.model,now));
        files.push(...router.files(),workerStatus('running',{model:response.model,...progress(),currentCategory:'mixed',inputTokens:response.inputTokens,queuedBatches:queue.length,message:`Đã xử lý ${translations.size+skippedIndexes.size}/${dataRows.length} dòng · ${skippedIndexes.size} dòng trống giữ nguyên`}));await uploadWithRetry(files);
        const missing=batch.filter(item=>!translations.has(item.index));if(missing.length)queue.unshift(...translationPlan(missing,router).batches);
      }catch(error){
        if(batch.length>10&&canSplit(error)){const middle=Math.ceil(batch.length/2);console.warn(`Translation batch ${batch.length} rows exceeded ${error.reason==='output_limit'?'the response limit':'the input limit'}; retrying as ${middle} + ${batch.length-middle}.`);queue.unshift(batch.slice(middle),batch.slice(0,middle));continue}
        const pausedAt=new Date().toISOString();await uploadWithRetry([...router.files(),workerStatus('paused',{model:error.model||primaryModel,...progress(),queuedBatches:queue.length+1,pauseReason:error.reason||'invalid_response',message:error.message,pausedAt}),...(error.quota?[jsonFile(`status/${projectId}/quota.json`,{runId,model:error.model||primaryModel,reason:error.reason||'rate_limit',quota:error.quota,message:error.message,pausedAt,stage:'translation'})]:[])]);await setReady(false);console.warn(error.message);return;
      }
    }
    const completedAt=new Date().toISOString();await uploadWithRetry([...router.files(),workerStatus('completed',{model:primaryModel,...progress(),queuedBatches:0,completedAt,message:'Đã dịch xong queue và lưu toàn bộ checkpoint'})]);await setReady(true);console.log(`Translated and saved ${translations.size}/${dataRows.length} rows`);
  }catch(error){if(error instanceof StoragePauseError){console.warn(error.message);return}try{await uploadWithRetry([workerStatus('failed',{error:error.message,failedAt:new Date().toISOString()})])}catch{}throw error}
}

await main();
