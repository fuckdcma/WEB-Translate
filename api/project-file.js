import {allowMethods,envState,listDatasetFiles,readDatasetJson,readDatasetText,readProjects,saveDatasetFiles,send} from './_shared.js';

function parseDelimited(content,delimiter){
  const rows=[];let row=[],value='',quoted=false;
  for(let index=0;index<content.length;index+=1){
    const char=content[index];
    if(char==='"'){
      if(quoted&&content[index+1]==='"'){value+='"';index+=1}else quoted=!quoted;
    }else if(char===delimiter&&!quoted){row.push(value);value=''}
    else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&content[index+1]==='\n')index+=1;row.push(value);if(row.some(cell=>cell!==''))rows.push(row);row=[];value=''}
    else value+=char;
  }
  row.push(value);if(row.some(cell=>cell!==''))rows.push(row);
  return rows;
}

function serializeDelimited(rows,delimiter){
  const encode=value=>{const text=String(value??'');return text.includes(delimiter)||/["\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text};
  return rows.map(row=>row.map(encode).join(delimiter)).join('\n');
}

function columnsFor(rows){
  const header=rows[0]||[];
  let target=header.findIndex(column=>/^(vietnamese|vi|translation)$/i.test(column.trim()));
  if(target<0){target=header.length;header.push('Vietnamese');for(let index=1;index<rows.length;index+=1)rows[index][target]=''}
  const source=header.findIndex((column,index)=>index!==target&&/^(languages?|source|english|text|original)$/i.test(column.trim()));
  return{target,source:source>=0?source:Math.min(1,Math.max(0,header.length-1))};
}

async function buildProjectFile(project){
  const delimiter=/\.csv$/i.test(project.fileName)?',':'\t';
  const extension=delimiter===','?'csv':'tsv';
  const finalPath=`results/${project.id}/final.${extension}`;
  const saved=await readDatasetText(finalPath);
  const sourceContent=await readDatasetText(`projects/${project.id}/${project.fileName}`);
  if(sourceContent===null)throw new Error('Không tìm thấy tệp nguồn của dự án');
  const sourceRows=parseDelimited(sourceContent,delimiter);
  let rows=saved===null?sourceRows:parseDelimited(saved,delimiter);
  if(rows.length!==sourceRows.length)rows=sourceRows;
  if(rows.length<2)throw new Error('Tệp nguồn không có dữ liệu');
  const {target,source}=columnsFor(rows);
  const applyTranslation=(index,value)=>{const row=rows[Number(index)+1];if(row&&String(value||'').trim()&&(saved===null||!String(row[target]||'').trim()))row[target]=String(value)};

  const allPaths=await listDatasetFiles();
  const checkpointPaths=allPaths.filter(path=>path.startsWith(`checkpoints/${project.id}/`)&&/\/shard-\d+\.json$/i.test(path));
  for(const path of checkpointPaths){
    const checkpoint=await readDatasetJson(path);
    for(const item of checkpoint?.translations||[])applyTranslation(item.index,item.translation)
  }

  const taskCheckpointPaths=allPaths.filter(path=>path.startsWith(`checkpoints/${project.id}/tasks/`)&&/\.json$/i.test(path));
  const completeTaskIds=new Set(taskCheckpointPaths.map(path=>path.split('/').pop().replace(/\.json$/i,'')));
  const partialCheckpointPaths=allPaths.filter(path=>path.startsWith(`checkpoints/${project.id}/partial/`)&&/\.json$/i.test(path)&&!completeTaskIds.has(path.split('/').pop().replace(/\.json$/i,'')));
  for(const path of partialCheckpointPaths){
    const checkpoint=await readDatasetJson(path);
    for(const item of checkpoint?.translations||[])applyTranslation(item.index,item.translation)
  }
  for(const path of taskCheckpointPaths){
    const checkpoint=await readDatasetJson(path);
    if(!checkpoint?.complete)continue;
    for(const item of checkpoint.translations||[])applyTranslation(item.index,item.translation)
  }

  const resultPaths=allPaths.filter(path=>path.startsWith(`results/${project.id}/`)&&/\/shard-\d+\.tsv$/i.test(path));
  const sourceRowsByKey=new Map();
  for(let index=1;index<rows.length;index+=1){const key=`${String(rows[index][0]||'')}\u0000${String(rows[index][source]||'')}`;if(!sourceRowsByKey.has(key))sourceRowsByKey.set(key,[]);sourceRowsByKey.get(key).push(index)}
  const usedByKey=new Map();
  for(const path of resultPaths.sort((a,b)=>Number(a.match(/shard-(\d+)/)?.[1])-Number(b.match(/shard-(\d+)/)?.[1]))){
    const shard=parseDelimited(await readDatasetText(path)||'',delimiter);
    if(shard.length<2)continue;
    const shardColumns=columnsFor(shard);
    for(const resultRow of shard.slice(1)){
      const key=`${String(resultRow[0]||'')}\u0000${String(resultRow[shardColumns.source]||'')}`;const candidates=sourceRowsByKey.get(key)||[];const used=usedByKey.get(key)||0;const rowIndex=candidates[Math.min(used,candidates.length-1)];
      if(rowIndex!==undefined&&resultRow[shardColumns.target])applyTranslation(rowIndex-1,resultRow[shardColumns.target]);
      usedByKey.set(key,used+1);
    }
  }
  return{content:serializeDelimited(rows,delimiter),delimiter,finalPath,manual:saved!==null};
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','PUT']))return;
  try{
    if(!envState().huggingFace)return send(res,503,{error:'Hãy cấu hình Hugging Face trên Vercel'});
    const projectId=String(req.method==='GET'?req.query?.id:req.body?.id||'');
    if(!projectId)return send(res,400,{error:'Thiếu mã dự án'});
    const projects=await readProjects();const project=projects.find(item=>item.id===projectId);
    if(!project)return send(res,404,{error:'Không tìm thấy dự án'});
    const built=await buildProjectFile(project);
    if(req.method==='GET'){
      const rows=parseDelimited(built.content,built.delimiter);const {target}=columnsFor(rows);const translatedRows=rows.slice(1).filter(row=>String(row[target]||'').trim()).length;
      const safeName=project.name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g,'-').replace(/[. ]+$/,'').slice(0,120)||'translation';
      return send(res,200,{project,fileName:`${safeName}-vi.${built.delimiter===','?'csv':'tsv'}`,content:serializeDelimited(rows,built.delimiter),delimiter:built.delimiter,translatedRows,totalRows:Math.max(0,rows.length-1),manual:built.manual});
    }
    const submitted=String(req.body?.content||'');
    if(!submitted.trim())return send(res,400,{error:'Nội dung chỉnh sửa không được để trống'});
    if(submitted.length>4_500_000)return send(res,413,{error:'Bản dịch vượt quá giới hạn 4,5 MB'});
    const sourceContent=await readDatasetText(`projects/${project.id}/${project.fileName}`);const sourceRows=parseDelimited(sourceContent||'',built.delimiter);const submittedRows=parseDelimited(submitted,built.delimiter);
    if(sourceRows.length!==submittedRows.length)return send(res,400,{error:'Không được thêm hoặc xoá dòng khi chỉnh sửa thủ công'});
    const sourceColumns=columnsFor(sourceRows);const submittedColumns=columnsFor(submittedRows);
    for(let index=1;index<sourceRows.length;index+=1){if(String(sourceRows[index][0]||'')!==String(submittedRows[index][0]||''))return send(res,400,{error:`Mã dòng ${index} đã bị thay đổi`});sourceRows[index][sourceColumns.target]=String(submittedRows[index][submittedColumns.target]||'')}
    const content=serializeDelimited(sourceRows,built.delimiter);const translatedRows=sourceRows.slice(1).filter(row=>String(row[sourceColumns.target]||'').trim()).length;const updatedAt=new Date().toISOString();
    await saveDatasetFiles([{path:built.finalPath,content:new Blob([content],{type:built.delimiter===','?'text/csv':'text/tab-separated-values'})},{path:`status/${project.id}/manual.json`,content:new Blob([JSON.stringify({status:'saved',translatedRows,totalRows:sourceRows.length-1,updatedAt},null,2)],{type:'application/json'})}]);
    return send(res,200,{ok:true,translatedRows,totalRows:sourceRows.length-1,updatedAt,message:'Đã lưu bản chỉnh sửa thủ công'});
  }catch(error){send(res,500,{error:error.message})}
}
