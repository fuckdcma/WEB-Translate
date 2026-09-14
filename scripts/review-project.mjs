import {createHash} from 'node:crypto';
import {downloadFile,uploadFiles} from '@huggingface/hub';
import {GooglePauseError,makeBatches,requestGoogle,sleep} from './google-api.mjs';

const required=['PROJECT_ID','RUN_ID','SHARD_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
const accessToken=process.env.HF_TOKEN;
const projectId=process.env.PROJECT_ID;
const runId=process.env.RUN_ID;
const shardCount=Math.min(4,Math.max(1,Number(process.env.SHARD_COUNT)||1));
const checkpointPath=`checkpoints/${projectId}/review.json`;
const statusPath=`status/${projectId}/review.json`;

class StoragePauseError extends Error{constructor(message){super(message);this.name='StoragePauseError'}}

function storageWait(error){
  if(Number(error?.statusCode)!==429&&!/rate limit for repository commits/i.test(String(error)))return 0;
  const minutes=Number(String(error).match(/retry this action in (\d+) minutes?/i)?.[1]);
  return (Number.isFinite(minutes)&&minutes>0?minutes:2)*60_000+10_000;
}

async function readFile(path){
  try{return await downloadFile({repo,path,accessToken})}catch(error){if(String(error).includes('404'))return null;throw error}
}

async function readJson(path){const response=await readFile(path);return response?JSON.parse(await response.text()):null}

async function uploadWithRetry(files){
  let lastError;
  for(let attempt=1;attempt<=3;attempt+=1)try{await uploadFiles({repo,accessToken,files});return}catch(error){lastError=error;const wait=storageWait(error);if(wait&&attempt<3){console.warn(`Hugging Face commit limit reached; waiting ${Math.ceil(wait/60_000)} minutes`);await sleep(wait);continue}if(wait)break;if(attempt<3)await sleep(800*attempt+Math.round(Math.random()*500))}
  if(storageWait(lastError))throw new StoragePauseError('Hugging Face đang giới hạn số lần lưu. Phiên sẽ dừng an toàn và có thể tiếp tục sau.')
  throw lastError;
}

function statusFile(status,extra={}){return{path:statusPath,content:new Blob([JSON.stringify({runId,status,updatedAt:new Date().toISOString(),...extra},null,2)],{type:'application/json'})}}
function checkpointFile(checkpoint){return{path:checkpointPath,content:new Blob([JSON.stringify(checkpoint,null,2)],{type:'application/json'})}}
async function writeStatus(status,extra={}){await uploadWithRetry([statusFile(status,extra)])}

async function main(){
  try{
    const rows=[];
    const missingShards=[];
    for(let index=0;index<shardCount;index+=1){
      const shardStatus=await readJson(`status/${projectId}/shard-${index}.json`);
      if(shardStatus?.runId!==runId||shardStatus?.status!=='completed'){missingShards.push(index);continue}
      const response=await readFile(`results/${projectId}/shard-${index}.tsv`);
      if(!response){missingShards.push(index);continue}
      const lines=(await response.text()).trim().split(/\r?\n/);
      lines.shift();
      for(const line of lines)rows.push({shard:index,text:line});
    }
    if(missingShards.length){
      await writeStatus('paused',{progress:0,checkedRows:0,totalRows:rows.length,pauseReason:'translation_incomplete',message:'Đã lưu phần dịch hoàn thành. Chọn Tiếp tục sau khi giới hạn Google được làm mới.',missingShards,pausedAt:new Date().toISOString()});
      console.warn(`Review paused; waiting for shards: ${missingShards.join(', ')}`);
      return;
    }

    const contentHash=createHash('sha256').update(rows.map(row=>row.text).join('\n')).digest('hex');
    const stored=await readJson(checkpointPath);
    const usable=stored?.version===1&&stored.contentHash===contentHash;
    const issues=Array.isArray(usable?stored.issues:null)?[...stored.issues]:[];
    let checkedRows=Math.min(rows.length,Number(usable?stored.checkedRows:0)||0);
    let apiRequests=Number(usable?stored.apiRequests:0)||0;
    let checkpoint={version:1,projectId,contentHash,checkedRows,issues,apiRequests,updatedAt:new Date().toISOString()};

    const remaining=rows.slice(checkedRows).map((row,index)=>({...row,row:checkedRows+index+1}));
    const batches=makeBatches(remaining,item=>({row:item.row,text:item.text}));
    for(let batchIndex=0;batchIndex<batches.length;batchIndex+=1){
      const batch=batches[batchIndex];
      const prompt=`You are the independent reviewer for Vietnamese game localization. Check every supplied line for missing translation, broken placeholders, altered proper names or locations, inconsistent pronouns, and meaning that conflicts with story context. Return JSON only as an object with an issues array. Each issue must contain row, severity (critical, warning, or note), and message in Vietnamese. Return an empty issues array when the batch is good.\n\n${JSON.stringify(batch.map(item=>({row:item.row,text:item.text})))}`;
      let payload;
      try{
        const response=await requestGoogle({prompt,temperature:0.1,label:'Google AI review'});
        payload=response.payload;
        apiRequests+=response.attempts;
      }catch(error){
        if(!(error instanceof GooglePauseError))throw error;
        apiRequests+=Number(error.attempts)||1;
        checkpoint={...checkpoint,checkedRows,issues,apiRequests,updatedAt:new Date().toISOString()};
        const progress=rows.length?Math.round(checkedRows/rows.length*100):100;
        await uploadWithRetry([checkpointFile(checkpoint),statusFile('paused',{progress,checkedRows,totalRows:rows.length,issueCount:issues.length,apiRequests,pauseReason:error.reason,message:error.message,pausedAt:new Date().toISOString()})]);
        console.warn(error.message);
        return;
      }

      const result=JSON.parse(payload.candidates?.[0]?.content?.parts?.[0]?.text||'{"issues":[]}');
      if(Array.isArray(result.issues))issues.push(...result.issues);
      checkedRows+=batch.length;
      checkpoint={...checkpoint,checkedRows,issues,apiRequests,updatedAt:new Date().toISOString()};
      const progress=rows.length?Math.round(checkedRows/rows.length*100):100;
      if(batchIndex<batches.length-1)await uploadWithRetry([checkpointFile(checkpoint),statusFile('running',{progress,checkedRows,totalRows:rows.length,issueCount:issues.length,apiRequests,resumed:Boolean(usable),checkpointedAt:checkpoint.updatedAt})]);
    }

    const completedAt=new Date().toISOString();
    const report={projectId,checkedRows:rows.length,issueCount:issues.length,issues,apiRequests,completedAt};
    checkpoint={...checkpoint,complete:true,checkedRows:rows.length,issues,apiRequests,updatedAt:completedAt};
    await uploadWithRetry([
      {path:`results/${projectId}/review.json`,content:new Blob([JSON.stringify(report,null,2)],{type:'application/json'})},
      checkpointFile(checkpoint),
      statusFile('completed',{progress:100,checkedRows:rows.length,totalRows:rows.length,issueCount:issues.length,apiRequests,completedAt})
    ]);
    console.log(`Reviewed ${rows.length} rows and found ${issues.length} issues; ${apiRequests} API attempts total`);
  }catch(error){
    if(error instanceof StoragePauseError){console.warn(error.message);return}
    try{await writeStatus('failed',{error:error.message,failedAt:new Date().toISOString()})}catch(statusError){console.error('Could not save failed review status:',statusError.message)}
    throw error;
  }
}

await main();
