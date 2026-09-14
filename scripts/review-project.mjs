import { downloadFile, uploadFiles } from '@huggingface/hub';

const required=['PROJECT_ID','RUN_ID','SHARD_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
const accessToken=process.env.HF_TOKEN;
const projectId=process.env.PROJECT_ID;
const runId=process.env.RUN_ID;
const shardCount=Math.min(16,Math.max(1,Number(process.env.SHARD_COUNT)||1));
const googleUrl='https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
const retryableGoogleStatuses=new Set([429,500,502,503,504]);
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

async function requestGoogle(prompt,temperature){
  for(let attempt=1;attempt<=8;attempt+=1){
    let response;
    try{
      response=await fetch(googleUrl,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature}})});
    }catch(error){
      if(attempt===8)throw new Error(`Google AI review network request failed after ${attempt} attempts: ${error.message}`);
      const delay=Math.min(45000,2000*2**(attempt-1))+Math.round(Math.random()*1500);
      console.warn(`Google AI review network retry ${attempt}/8 in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    if(response.ok)return response.json();
    const detail=await response.text();
    if(!retryableGoogleStatuses.has(response.status)||attempt===8)throw new Error(`Google AI review failed: ${response.status} ${detail}`);
    const retryAfterSeconds=Number(response.headers.get('retry-after'));
    const delay=Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0?retryAfterSeconds*1000:Math.min(45000,2000*2**(attempt-1))+Math.round(Math.random()*1500);
    console.warn(`Google AI review returned ${response.status}; retry ${attempt}/8 in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error('Google AI review failed after retries');
}

async function writeStatus(status,extra={}){
  let lastError;
  for(let attempt=0;attempt<4;attempt+=1)try{
    await uploadFiles({repo,accessToken,files:[{path:`status/${projectId}/review.json`,content:new Blob([JSON.stringify({runId,status,updatedAt:new Date().toISOString(),...extra},null,2)],{type:'application/json'})}]});
    return;
  }catch(error){lastError=error;await sleep(300*(attempt+1))}
  throw lastError;
}

async function main(){
  await writeStatus('running',{progress:0,checkedRows:0,startedAt:new Date().toISOString()});
  try{
    const rows=[];
    for(let index=0;index<shardCount;index+=1){
      const response=await downloadFile({repo,path:`results/${projectId}/shard-${index}.tsv`,accessToken});
      if(!response)throw new Error(`Missing translation result for shard ${index}`);
      const lines=(await response.text()).trim().split(/\r?\n/);
      lines.shift();
      for(const line of lines)rows.push({shard:index,text:line});
    }

    const issues=[];
    let lastReportedProgress=0;
    for(let offset=0;offset<rows.length;offset+=60){
      const batch=rows.slice(offset,offset+60).map((row,index)=>({row:offset+index+1,text:row.text}));
      const prompt=`You are the independent reviewer for Vietnamese game localization. Check every supplied line for missing translation, broken placeholders, altered proper names or locations, inconsistent pronouns, and meaning that conflicts with story context. Return JSON only as an object with an issues array. Each issue must contain row, severity (critical, warning, or note), and message in Vietnamese. Return an empty issues array when the batch is good.\n\n${JSON.stringify(batch)}`;
      const payload=await requestGoogle(prompt,0.1);
      const result=JSON.parse(payload.candidates?.[0]?.content?.parts?.[0]?.text||'{"issues":[]}');
      if(Array.isArray(result.issues))issues.push(...result.issues);
      const checkedRows=Math.min(rows.length,offset+batch.length);
      const progress=rows.length?Math.round(checkedRows/rows.length*100):100;
      if(progress>=lastReportedProgress+10&&progress<100){await writeStatus('running',{progress,checkedRows,totalRows:rows.length,issueCount:issues.length});lastReportedProgress=progress}
    }

    const report={projectId,checkedRows:rows.length,issueCount:issues.length,issues,completedAt:new Date().toISOString()};
    await uploadFiles({repo,accessToken,files:[{path:`results/${projectId}/review.json`,content:new Blob([JSON.stringify(report,null,2)],{type:'application/json'})}]});
    await writeStatus('completed',{progress:100,checkedRows:rows.length,totalRows:rows.length,issueCount:issues.length,completedAt:report.completedAt});
    console.log(`Reviewed ${rows.length} rows and found ${issues.length} issues`);
  }catch(error){
    try{await writeStatus('failed',{error:error.message,failedAt:new Date().toISOString()})}catch(statusError){console.error('Could not save failed review status:',statusError.message)}
    throw error;
  }
}

await main();
