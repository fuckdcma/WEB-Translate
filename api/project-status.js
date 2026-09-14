import {allowMethods,listDatasetFiles,readDatasetJson,readProjects,readProjectStatus,send} from './_shared.js';

const step=(id,label,status,detail)=>({id,label,status,detail});
const when=value=>{const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0};
const taskIdFromPath=path=>path.split('/').pop()?.replace(/\.json$/i,'')||'';
function nextAutomaticCheck(notBefore=Date.now()){const date=new Date(Math.max(Date.now(),Number(notBefore)||0));const minute=date.getUTCMinutes();date.setUTCSeconds(0,0);date.setUTCMinutes(minute<7?7:minute<37?37:67);return date.toISOString()}
function etaFor({totalRows,processedRows,analysisComplete,review,quota}){
  const analysisRequests=analysisComplete?0:Math.ceil(totalRows/800);
  const translationRequests=Math.ceil(Math.max(0,totalRows-processedRows)/700);
  const reviewRows=Math.max(0,totalRows-Number(review?.checkedRows||0));
  const reviewRequests=Math.ceil(reviewRows/400);
  const requests=analysisRequests+translationRequests+reviewRequests;
  const activeMinutes=Math.max(1,requests);
  const dailyLimit=Number(quota?.quota?.requestsPerDay)||0;
  if(!requests)return{requests:0,activeMinutes:0,label:'Sắp hoàn thành'};
  if(dailyLimit){const days=Math.max(1,Math.ceil(requests/dailyLimit));return{requests,activeMinutes,dailyLimit,days,estimatedAt:new Date(Date.now()+days*86_400_000).toISOString(),label:`Khoảng ${days} ngày theo giới hạn hiện tại`}}
  return{requests,activeMinutes,label:`Khoảng ${activeMinutes} phút xử lý thực tế, chưa gồm thời gian Google làm mới giới hạn`};
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET']))return;
  try{
    const projectId=String(req.query?.id||'');
    if(!projectId)return send(res,400,{error:'Thiếu mã dự án'});
    const projects=await readProjects();
    const project=projects.find(item=>item.id===projectId);
    if(!project)return send(res,404,{error:'Không tìm thấy dự án'});
    const [created,dispatch,analysis,review,completedReport,manual,coordinator,quota,automation,glossary]=await Promise.all([
      readProjectStatus(projectId,'project'),readProjectStatus(projectId,'dispatch'),readProjectStatus(projectId,'analysis'),readProjectStatus(projectId,'review'),readDatasetJson(`results/${projectId}/review.json`),readProjectStatus(projectId,'manual'),readProjectStatus(projectId,'coordinator'),readProjectStatus(projectId,'quota'),readProjectStatus(projectId,'automation'),readDatasetJson(`glossaries/${projectId}.json`)
    ]);
    const workers=Math.min(4,Math.max(0,Number(dispatch?.workers)||0));
    const currentCoordinator=coordinator?.totalTasks?coordinator:null;
    const modern=Boolean(currentCoordinator);
    const storedWorkers=workers?await Promise.all(Array.from({length:workers},(_,index)=>readProjectStatus(projectId,`${modern?'worker':'shard'}-${index}`))):[];
    const activeWorkers=storedWorkers.map(item=>item?.runId===dispatch?.runId?item:null);
    const currentReview=review?.runId===dispatch?.runId?review:null;
    const currentAnalysis=analysis?.runId===dispatch?.runId?analysis:null;
    let manifest=null;
    let completedTaskIds=new Set();
    let partialRecords=[];
    if(modern){
      const [loadedManifest,checkpointPaths]=await Promise.all([readDatasetJson(`queues/${projectId}/${currentCoordinator.runId}/manifest.json`),listDatasetFiles(`checkpoints/${projectId}/`)]);
      manifest=loadedManifest;
      const completePaths=checkpointPaths.filter(path=>path.includes('/tasks/')&&/\.json$/i.test(path));
      completedTaskIds=new Set(completePaths.map(taskIdFromPath));
      const partialPaths=checkpointPaths.filter(path=>path.includes('/partial/')&&/\.json$/i.test(path)&&!completedTaskIds.has(taskIdFromPath(path)));
      partialRecords=(await Promise.all(partialPaths.map(path=>readDatasetJson(path)))).filter(Boolean);
    }
    const manifestTasks=Array.isArray(manifest?.tasks)?manifest.tasks:[];
    const taskById=new Map(manifestTasks.map(task=>[task.id,task]));
    const persistedTasks=manifestTasks.filter(task=>completedTaskIds.has(task.id));
    const persistedByWorker=Array.from({length:workers},()=>({completedTasks:0,processedRows:0,totalTasks:0,totalRows:0}));
    for(const task of manifestTasks){const index=workers?task.sequence%workers:0;const bucket=persistedByWorker[index];if(!bucket)continue;bucket.totalTasks+=1;bucket.totalRows+=Number(task.rowCount)||0;if(completedTaskIds.has(task.id)){bucket.completedTasks+=1;bucket.processedRows+=Number(task.rowCount)||0}}
    let partialRows=0;
    for(const record of partialRecords){const task=taskById.get(record.taskId);if(!task||record.sourceHash!==manifest?.sourceHash)continue;const translated=new Set((record.translations||[]).filter(item=>String(item.translation||'').trim()).map(item=>Number(item.index)));const count=task.rowIndexes.filter(index=>translated.has(index)).length;partialRows+=count;const index=workers?task.sequence%workers:0;if(persistedByWorker[index])persistedByWorker[index].processedRows+=count}
    const summary={pending:0,running:0,completed:0,paused:0,failed:0};
    for(const worker of activeWorkers){const status=worker?.status||'pending';if(status in summary)summary[status]+=1;else summary.pending+=1}
    let completedTasks=modern?persistedTasks.length:activeWorkers.reduce((total,item)=>total+Math.max(0,Number(item?.completedTasks)||0),0);
    let processedRows=modern?persistedTasks.reduce((total,item)=>total+Math.max(0,Number(item.rowCount)||0),partialRows):activeWorkers.reduce((total,item)=>total+Math.max(0,Number(item?.processedRows)||0),0);
    processedRows=Math.min(Number(project.totalRows)||0,Math.max(processedRows,Number(manual?.translatedRows)||0));
    const totalTasks=modern?manifestTasks.length:Number(currentCoordinator?.totalTasks)||0;
    const translationComplete=modern?totalTasks>0&&completedTasks>=totalTasks:workers>0&&summary.completed===workers;
    const reviewState=currentReview?.status||'waiting';
    const analysisComplete=Boolean(glossary?.fixed&&glossary?.sourceHash===manifest?.sourceHash);
    const analysisState=analysisComplete?'completed':currentAnalysis?.status||'waiting';
    const hasPause=summary.paused>0||reviewState==='paused'||analysisState==='paused';
    const hasFailure=summary.failed>0||reviewState==='failed'||analysisState==='failed';
    const totalRows=Number(project.totalRows)||0;
    const reportComplete=totalRows>0&&Number(completedReport?.checkedRows)>=totalRows;
    const manualComplete=totalRows>0&&Number(manual?.translatedRows)>=totalRows;
    const completionAt=Math.max(when(completedReport?.completedAt),when(manual?.updatedAt));
    const activeAfterCompletion=Boolean(dispatch?.runId&&when(dispatch?.queuedAt)>completionAt);
    const archivedComplete=(reportComplete||manualComplete)&&!activeAfterCompletion;
    if(archivedComplete)processedRows=totalRows;
    const isComplete=archivedComplete||(translationComplete&&reviewState==='completed');
    const effectiveReview=isComplete&&completedReport?{status:'completed',progress:100,checkedRows:Number(completedReport.checkedRows)||totalRows,issueCount:Number(completedReport.issueCount)||0,correctionCount:Number(completedReport.correctionCount)||0,completedAt:completedReport.completedAt,restored:archivedComplete}:currentReview;
    const translationPercent=totalRows?Math.round(processedRows/totalRows*100):(translationComplete?100:0);
    const reviewPercent=isComplete?100:Math.max(0,Math.min(100,Number(currentReview?.progress)||0));
    const progress=isComplete?100:translationComplete?Math.min(99,90+Math.round(reviewPercent*.09)):translationPercent;
    const state=isComplete?'done':hasFailure?'failed':hasPause?'paused':'working';
    const retryAfter=Math.max(Date.now(),when(dispatch?.queuedAt)+20*60_000,when(automation?.lastAttemptAt)+20*60_000);
    const storedNext=when(automation?.nextAttemptAt)>retryAfter?automation.nextAttemptAt:null;
    const autoResume={enabled:true,status:automation?.status||'scheduled',nextAttemptAt:storedNext||(!isComplete&&hasPause?nextAutomaticCheck(retryAfter):null),lastAttemptAt:automation?.lastAttemptAt||null,message:automation?.message||'Hệ thống tự kiểm tra và tiếp tục, không cần bấm nút.'};
    const currentStage=isComplete?'Hoàn thành':hasFailure?'Đang tự lưu lỗi và chờ thử lại':analysisState==='running'?`Đang phân loại và tạo glossary · ${Number(currentAnalysis?.processedRows||0).toLocaleString('vi-VN')}/${totalRows.toLocaleString('vi-VN')}`:hasPause?`Đã lưu ${processedRows.toLocaleString('vi-VN')}/${totalRows.toLocaleString('vi-VN')} dòng - queue sẽ tự tiếp tục`:reviewState==='running'?'Đang kiểm tra theo glossary':translationComplete?'Đang chờ kiểm tra cuối':modern&&summary.running+summary.completed>0?'Đang dịch lô token':currentCoordinator?'Queue đã sẵn sàng':'Đang khởi tạo queue';
    const categories=currentCoordinator?.categories||completedReport?.categories||null;
    const categoryDetail=categories?`Menu ${Number(categories.menu)||0} · Tương tác ${Number(categories.interaction)||0} · Cốt truyện ${Number(categories.story)||0}`:'';
    const responseWorkers=archivedComplete?1:workers;
    const responseSummary=archivedComplete?{pending:0,running:0,completed:1,paused:0,failed:0}:summary;
    const responseItems=archivedComplete?[{index:0,status:'completed',progress:100,processedRows:totalRows,completedTasks:totalTasks||1,totalTasks:totalTasks||1,restored:true}]:activeWorkers.map((item,index)=>({...persistedByWorker[index],index,status:item?.status||'pending',...item,completedTasks:persistedByWorker[index]?.completedTasks||Number(item?.completedTasks)||0,processedRows:persistedByWorker[index]?.processedRows||Number(item?.processedRows)||0,totalTasks:persistedByWorker[index]?.totalTasks||Number(item?.totalTasks)||0,totalRows:persistedByWorker[index]?.totalRows||Number(item?.totalRows)||0}));
    const estimate=etaFor({totalRows,processedRows,analysisComplete,review:effectiveReview,quota});
    const steps=[
      step('validate','Kiểm tra tệp',isComplete||created?.fileValidated?'complete':'active',isComplete||created?.fileValidated?'Định dạng tệp hợp lệ':'Đang kiểm tra'),
      step('store','Lưu dữ liệu',isComplete||created?.stored?'complete':created?'active':'waiting',isComplete||created?.stored?'Đã lưu an toàn':'Đang chờ'),
      step('coordinate','Đánh ID và tạo queue',isComplete||currentCoordinator?'complete':dispatch?'active':'waiting',currentCoordinator?`${totalTasks} checkpoint nội bộ · không gửi toàn bộ tệp`:'Đang chuẩn bị'),
      step('analysis','Category và glossary',isComplete||analysisComplete?'complete':analysisState==='failed'?'error':analysisState==='paused'?'paused':analysisState==='running'?'active':'waiting',analysisComplete?`${Number(glossary?.terms?.length||0)} thuật ngữ đã cố định`:analysisState==='running'?`${Number(currentAnalysis?.processedRows||0)}/${totalRows} dòng đã phân tích`:analysisState==='paused'?'Đã lưu checkpoint phân tích':'Đang chờ queue'),
      step('translate','Dịch các lô token',isComplete?'complete':hasFailure?'active':summary.paused?'paused':translationComplete?'complete':analysisComplete?'active':'waiting',isComplete?`${processedRows}/${totalRows} dòng đã lưu`:`${processedRows}/${totalRows} dòng · ${completedTasks}/${totalTasks} checkpoint hoàn chỉnh`),
      step('review','Kiểm tra và cân nhắc chỉnh sửa',isComplete?'complete':reviewState==='failed'?'active':reviewState==='paused'?'waiting':reviewState==='completed'?'complete':translationComplete||reviewState==='running'?'active':'waiting',isComplete?`${Number(effectiveReview?.checkedRows||totalRows).toLocaleString('vi-VN')} dòng · ${Number(effectiveReview?.correctionCount||0)} chỉnh sửa`:reviewState==='running'?`${reviewPercent}% đã kiểm tra`:'Tự bắt đầu sau khi dịch xong'),
      step('complete','Tạo tệp hoàn chỉnh',isComplete?'complete':hasPause?'waiting':hasFailure?'active':'waiting',isComplete?'Sẵn sàng tải xuống':hasPause?'Hệ thống sẽ tự tiếp tục':'Đang chờ')
    ];
    send(res,200,{project:{...project,progress,status:state,translatedRows:processedRows},state,currentStage,progress,workers:responseWorkers,summary:responseSummary,shards:responseItems,coordinator:currentCoordinator||categories&&{categories,totalTasks,taskSize:Number(currentCoordinator?.taskSize)||0},analysis:currentAnalysis,glossary:analysisComplete?{termCount:Number(glossary?.terms?.length)||0}:null,completedTasks,totalTasks,review:effectiveReview,manual,quota,automation:autoResume,estimate,steps,updatedAt:new Date().toISOString()});
  }catch(error){send(res,500,{error:error.message})}
}
