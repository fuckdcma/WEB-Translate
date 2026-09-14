import { downloadFile, uploadFiles } from '@huggingface/hub';

const required=['PROJECT_ID','RUN_ID','SHARD_INDEX','SHARD_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
const accessToken=process.env.HF_TOKEN;
const projectId=process.env.PROJECT_ID;
const runId=process.env.RUN_ID;
const shardIndex=Number(process.env.SHARD_INDEX);
const shardCount=Number(process.env.SHARD_COUNT);
const googleUrl='https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
const retryableGoogleStatuses=new Set([429,500,502,503,504]);
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

async function requestGoogle(prompt,temperature){
  for(let attempt=1;attempt<=8;attempt+=1){
    let response;
    try{
      response=await fetch(googleUrl,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature}})});
    }catch(error){
      if(attempt===8)throw new Error(`Google AI network request failed after ${attempt} attempts: ${error.message}`);
      const delay=Math.min(45000,2000*2**(attempt-1))+Math.round(Math.random()*1500);
      console.warn(`Google AI network retry ${attempt}/8 in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    if(response.ok)return response.json();
    const detail=await response.text();
    if(!retryableGoogleStatuses.has(response.status)||attempt===8)throw new Error(`Google AI request failed: ${response.status} ${detail}`);
    const retryAfterSeconds=Number(response.headers.get('retry-after'));
    const delay=Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0?retryAfterSeconds*1000:Math.min(45000,2000*2**(attempt-1))+Math.round(Math.random()*1500);
    console.warn(`Google AI returned ${response.status}; retry ${attempt}/8 in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error('Google AI request failed after retries');
}

async function writeStatus(status,extra={}){
  let lastError;
  for(let attempt=0;attempt<4;attempt+=1)try{
    await uploadFiles({repo,accessToken,files:[{path:`status/${projectId}/shard-${shardIndex}.json`,content:new Blob([JSON.stringify({runId,index:shardIndex,status,updatedAt:new Date().toISOString(),...extra},null,2)],{type:'application/json'})}]});
    return;
  }catch(error){lastError=error;await sleep(300*(attempt+1)+shardIndex*80)}
  throw lastError;
}

async function main(){
  await writeStatus('running',{progress:0,startedAt:new Date().toISOString()});
  try{
    const metadataResponse=await downloadFile({repo,path:'projects.json',accessToken});
    if(!metadataResponse)throw new Error('projects.json not found');
    const projects=JSON.parse(await metadataResponse.text());
    const project=projects.find(item=>item.id===projectId);
    if(!project)throw new Error(`Project not found: ${projectId}`);
    const sourceResponse=await downloadFile({repo,path:`projects/${project.id}/${project.fileName}`,accessToken});
    if(!sourceResponse)throw new Error('Source file not found');
    const source=await sourceResponse.text();
    const delimiter=/\.csv$/i.test(project.fileName)?',':'\t';
    const lines=source.trim().split(/\r?\n/);
    const header=lines.shift();
    const headerColumns=header.split(delimiter);
    const targetColumn=headerColumns.findIndex(column=>/^(vietnamese|vi|translation)$/i.test(column.trim()));
    const selected=lines.map((line,index)=>({line,index})).filter(item=>item.index%shardCount===shardIndex);
    const output=[targetColumn>=0?header:`${header}${delimiter}Vietnamese`];

    let lastReportedProgress=0;
    await sleep(shardIndex*600);
    for(let offset=0;offset<selected.length;offset+=30){
      const batch=selected.slice(offset,offset+30);
      const prompt=`You are translating game localization strings from ${project.sourceLanguage} to ${project.targetLanguage}.
Preserve keys, placeholders, proper names and locations. Keep pronouns and tone consistent across the batch.
Return JSON only as an array of objects with fields index and translation. Do not add Markdown.

${JSON.stringify(batch.map(item=>({index:item.index,text:item.line.split(delimiter).slice(1).join(delimiter)})))}`;
      const payload=await requestGoogle(prompt,0.2);
      const text=payload.candidates?.[0]?.content?.parts?.[0]?.text;
      const translations=JSON.parse(text||'[]');
      const byIndex=new Map(translations.map(item=>[Number(item.index),String(item.translation||'')]));
      for(const item of batch){const columns=item.line.split(delimiter);const translation=byIndex.get(item.index)||'';if(targetColumn>=0)columns[targetColumn]=translation;else columns.push(translation);output.push(columns.join(delimiter))}
      const progress=selected.length?Math.round(Math.min(selected.length,offset+batch.length)/selected.length*100):100;
      if(progress>=lastReportedProgress+10&&progress<100){await writeStatus('running',{progress,processedRows:Math.min(selected.length,offset+batch.length),totalRows:selected.length});lastReportedProgress=progress}
    }

    await uploadFiles({repo,accessToken,files:[{path:`results/${project.id}/shard-${shardIndex}.tsv`,content:new Blob([output.join('\n')],{type:'text/tab-separated-values'})}]});
    await writeStatus('completed',{progress:100,processedRows:selected.length,totalRows:selected.length,completedAt:new Date().toISOString()});
    console.log(`Translated ${selected.length} rows for shard ${shardIndex}/${shardCount}`);
  }catch(error){
    try{await writeStatus('failed',{error:error.message,failedAt:new Date().toISOString()})}catch(statusError){console.error('Could not save failed status:',statusError.message)}
    throw error;
  }
}

await main();
