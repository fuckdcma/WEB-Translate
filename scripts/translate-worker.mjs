import { downloadFile, uploadFiles } from '@huggingface/hub';

const required=['PROJECT_ID','SHARD_INDEX','SHARD_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
const accessToken=process.env.HF_TOKEN;
const projectId=process.env.PROJECT_ID;
const shardIndex=Number(process.env.SHARD_INDEX);
const shardCount=Number(process.env.SHARD_COUNT);

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

for(let offset=0;offset<selected.length;offset+=30){
  const batch=selected.slice(offset,offset+30);
  const prompt=`You are translating game localization strings from ${project.sourceLanguage} to ${project.targetLanguage}.
Preserve keys, placeholders, proper names and locations. Keep pronouns and tone consistent across the batch.
Return JSON only as an array of objects with fields index and translation. Do not add Markdown.

${JSON.stringify(batch.map(item=>({index:item.index,text:item.line.split(delimiter).slice(1).join(delimiter)})))}`;
  const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.2}})});
  if(!response.ok)throw new Error(`Google AI request failed: ${response.status} ${await response.text()}`);
  const payload=await response.json();
  const text=payload.candidates?.[0]?.content?.parts?.[0]?.text;
  const translations=JSON.parse(text||'[]');
  const byIndex=new Map(translations.map(item=>[Number(item.index),String(item.translation||'')]));
  for(const item of batch){const columns=item.line.split(delimiter);const translation=byIndex.get(item.index)||'';if(targetColumn>=0)columns[targetColumn]=translation;else columns.push(translation);output.push(columns.join(delimiter))}
}

await uploadFiles({repo,accessToken,files:[{path:`results/${project.id}/shard-${shardIndex}.tsv`,content:new Blob([output.join('\n')],{type:'text/tab-separated-values'})}]});
console.log(`Translated ${selected.length} rows for shard ${shardIndex}/${shardCount}`);
