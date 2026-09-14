import {createHash} from 'node:crypto';
import {downloadFile,uploadFiles} from '@huggingface/hub';
import {GooglePauseError,makeBatches,requestGoogle,sleep} from './google-api.mjs';

const required=['PROJECT_ID','RUN_ID','SHARD_INDEX','SHARD_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
const accessToken=process.env.HF_TOKEN;
const projectId=process.env.PROJECT_ID;
const runId=process.env.RUN_ID;
const shardIndex=Number(process.env.SHARD_INDEX);
const shardCount=Number(process.env.SHARD_COUNT);
const checkpointPath=`checkpoints/${projectId}/shard-${shardIndex}.json`;
const statusPath=`status/${projectId}/shard-${shardIndex}.json`;

async function readJson(path){
  try{const response=await downloadFile({repo,path,accessToken});return response?JSON.parse(await response.text()):null}catch(error){if(String(error).includes('404'))return null;throw error}
}

async function uploadWithRetry(files){
  let lastError;
  for(let attempt=1;attempt<=6;attempt+=1)try{
    await uploadFiles({repo,accessToken,files});
    return;
  }catch(error){
    lastError=error;
    if(attempt<6)await sleep(500*attempt+shardIndex*120+Math.round(Math.random()*500));
  }
  throw lastError;
}

function statusFile(status,extra={}){
  return{path:statusPath,content:new Blob([JSON.stringify({runId,index:shardIndex,status,updatedAt:new Date().toISOString(),...extra},null,2)],{type:'application/json'})};
}

function checkpointFile(checkpoint){return{path:checkpointPath,content:new Blob([JSON.stringify(checkpoint,null,2)],{type:'application/json'})}}
async function persist(checkpoint,status,extra={}){await uploadWithRetry([checkpointFile(checkpoint),statusFile(status,extra)])}
async function writeStatus(status,extra={}){await uploadWithRetry([statusFile(status,extra)])}

function translatedOutput(header,selected,targetColumn,delimiter,translations){
  const output=[targetColumn>=0?header:`${header}${delimiter}Vietnamese`];
  for(const item of selected){
    const columns=item.line.split(delimiter);
    const translation=translations.get(item.index)||'';
    if(targetColumn>=0)columns[targetColumn]=translation;else columns.push(translation);
    output.push(columns.join(delimiter));
  }
  return output.join('\n');
}

async function main(){
  let checkpoint;
  try{
    const metadataResponse=await downloadFile({repo,path:'projects.json',accessToken});
    if(!metadataResponse)throw new Error('projects.json not found');
    const projects=JSON.parse(await metadataResponse.text());
    const project=projects.find(item=>item.id===projectId);
    if(!project)throw new Error(`Project not found: ${projectId}`);
    const sourceResponse=await downloadFile({repo,path:`projects/${project.id}/${project.fileName}`,accessToken});
    if(!sourceResponse)throw new Error('Source file not found');
    const source=await sourceResponse.text();
    const sourceHash=createHash('sha256').update(source).digest('hex');
    const delimiter=/\.csv$/i.test(project.fileName)?',':'\t';
    const lines=source.trim().split(/\r?\n/);
    const header=lines.shift();
    const headerColumns=header.split(delimiter);
    const targetColumn=headerColumns.findIndex(column=>/^(vietnamese|vi|translation)$/i.test(column.trim()));
    const sourceColumn=headerColumns.findIndex((column,index)=>index!==targetColumn&&/^(languages?|source|english|text|original)$/i.test(column.trim()));
    const selected=lines.map((line,index)=>({line,index})).filter(item=>item.index%shardCount===shardIndex);
    const stored=await readJson(checkpointPath);
    const usable=stored?.version===1&&stored.sourceHash===sourceHash&&stored.shardCount===shardCount&&stored.shardIndex===shardIndex;
    const translations=new Map((usable?stored.translations:[]).map(item=>[Number(item.index),String(item.translation||'')]));
    checkpoint={version:1,projectId,sourceHash,shardIndex,shardCount,translations:[...translations].map(([index,translation])=>({index,translation})),updatedAt:new Date().toISOString()};
    let apiRequests=Number(usable?stored.apiRequests:0)||0;
    const completedBefore=selected.filter(item=>translations.has(item.index)).length;
    const initialProgress=selected.length?Math.round(completedBefore/selected.length*100):100;
    await persist(checkpoint,'running',{progress:initialProgress,processedRows:completedBefore,totalRows:selected.length,apiRequests,resumed:completedBefore>0,startedAt:new Date().toISOString()});

    const sourceText=item=>{
      const columns=item.line.split(delimiter);
      const value=columns[sourceColumn>=0?sourceColumn:Math.min(1,columns.length-1)]||'';
      return{index:item.index,key:columns[0]||'',text:value};
    };
    const remaining=selected.filter(item=>!translations.has(item.index));
    const batches=makeBatches(remaining,sourceText);
    await sleep(shardIndex*900);

    for(const batch of batches){
      const prompt=`Translate the following game localization strings from ${project.sourceLanguage} to ${project.targetLanguage}.
Preserve placeholders, markup, proper names and locations exactly. Keep pronouns, terminology and tone consistent across this batch. Translate only the text field; use the key only as context.
Return JSON only as an array of objects with fields index and translation. Return exactly one object for every supplied index. Do not add Markdown.\n\n${JSON.stringify(batch.map(sourceText))}`;
      let payload;
      try{
        const response=await requestGoogle({prompt,temperature:0.2,label:'Google AI translation'});
        payload=response.payload;
        apiRequests+=response.attempts;
      }catch(error){
        if(!(error instanceof GooglePauseError))throw error;
        apiRequests+=Number(error.attempts)||1;
        checkpoint={...checkpoint,apiRequests,translations:[...translations].map(([index,translation])=>({index,translation})),updatedAt:new Date().toISOString()};
        const processedRows=selected.filter(item=>translations.has(item.index)).length;
        const progress=selected.length?Math.round(processedRows/selected.length*100):100;
        await persist(checkpoint,'paused',{progress,processedRows,totalRows:selected.length,apiRequests,pauseReason:error.reason,message:error.message,pausedAt:new Date().toISOString()});
        console.warn(error.message);
        return;
      }

      const text=payload.candidates?.[0]?.content?.parts?.[0]?.text;
      const translated=JSON.parse(text||'[]');
      const byIndex=new Map(translated.map(item=>[Number(item.index),String(item.translation||'')]));
      const missing=batch.filter(item=>!byIndex.get(item.index));
      if(missing.length)throw new Error(`Google AI returned an incomplete batch (${missing.length} missing translations)`);
      for(const item of batch)translations.set(item.index,byIndex.get(item.index));
      const processedRows=selected.filter(item=>translations.has(item.index)).length;
      const progress=selected.length?Math.round(processedRows/selected.length*100):100;
      checkpoint={...checkpoint,apiRequests,translations:[...translations].map(([index,translation])=>({index,translation})),updatedAt:new Date().toISOString()};
      await persist(checkpoint,'running',{progress,processedRows,totalRows:selected.length,apiRequests,checkpointedAt:checkpoint.updatedAt});
    }

    const output=translatedOutput(header,selected,targetColumn,delimiter,translations);
    checkpoint={...checkpoint,complete:true,apiRequests,translations:[...translations].map(([index,translation])=>({index,translation})),updatedAt:new Date().toISOString()};
    await uploadWithRetry([
      {path:`results/${project.id}/shard-${shardIndex}.tsv`,content:new Blob([output],{type:'text/tab-separated-values'})},
      checkpointFile(checkpoint),
      statusFile('completed',{progress:100,processedRows:selected.length,totalRows:selected.length,apiRequests,completedAt:new Date().toISOString()})
    ]);
    console.log(`Translated ${selected.length} rows for shard ${shardIndex}/${shardCount}; ${remaining.length} new rows; ${apiRequests} API attempts total`);
  }catch(error){
    try{await writeStatus('failed',{error:error.message,failedAt:new Date().toISOString()})}catch(statusError){console.error('Could not save failed status:',statusError.message)}
    throw error;
  }
}

await main();
