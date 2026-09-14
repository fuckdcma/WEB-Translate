import {allowMethods,readDatasetJson,readProjects,readProjectStatus,send} from './_shared.js';

const step=(id,label,status,detail)=>({id,label,status,detail});

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET']))return;
  try{
    const projectId=String(req.query?.id||'');
    if(!projectId)return send(res,400,{error:'Thiếu mã dự án'});
    const projects=await readProjects();
    const project=projects.find(item=>item.id===projectId);
    if(!project)return send(res,404,{error:'Không tìm thấy dự án'});

    const [created,dispatch,review,completedReport]=await Promise.all([
      readProjectStatus(projectId,'project'),
      readProjectStatus(projectId,'dispatch'),
      readProjectStatus(projectId,'review'),
      readDatasetJson(`results/${projectId}/review.json`)
    ]);
    const workers=Math.min(16,Math.max(0,Number(dispatch?.workers)||0));
    const storedShards=workers?await Promise.all(Array.from({length:workers},(_,index)=>readProjectStatus(projectId,`shard-${index}`))):[];
    const shards=storedShards.map(item=>item?.runId===dispatch?.runId?item:null);
    const currentReview=review?.runId===dispatch?.runId?review:null;
    const summary={pending:0,running:0,completed:0,paused:0,failed:0};
    let processedRows=0;
    for(const shard of shards){
      const state=shard?.status||'pending';
      if(state in summary)summary[state]+=1;else summary.pending+=1;
      processedRows+=Math.max(0,Number(shard?.processedRows)||0);
    }
    const savedRows=storedShards.reduce((total,shard)=>total+Math.max(0,Number(shard?.processedRows)||0),0);
    processedRows=Math.min(Number(project.totalRows)||0,Math.max(processedRows,savedRows));
    const translationComplete=workers>0&&summary.completed===workers;
    const translationPercent=Number(project.totalRows)?Math.round(processedRows/Number(project.totalRows)*100):(translationComplete?100:0);
    const reviewState=currentReview?.status||'waiting';
    const hasPause=summary.paused>0||reviewState==='paused';
    const hasFailure=summary.failed>0||reviewState==='failed';
    const archivedComplete=Number(completedReport?.checkedRows)>=Number(project.totalRows)&&Number(project.totalRows)>0;
    if(archivedComplete)processedRows=Number(project.totalRows);
    const isComplete=archivedComplete||(translationComplete&&reviewState==='completed');
    const effectiveReview=archivedComplete?{status:'completed',progress:100,checkedRows:Number(completedReport.checkedRows),issueCount:Number(completedReport.issueCount)||0,completedAt:completedReport.completedAt,restored:true}:currentReview;
    const reviewPercent=isComplete?100:Math.max(0,Math.min(100,Number(currentReview?.progress)||0));
    const progress=isComplete?100:reviewState==='running'||reviewState==='paused'?Math.min(99,85+Math.round(reviewPercent*.14)):dispatch?Math.min(85,20+Math.round(translationPercent*.65)):created?15:0;
    const state=isComplete?'done':hasFailure?'failed':hasPause?'paused':'working';
    const currentStage=isComplete?'Hoàn thành':hasFailure?'Cần kiểm tra':hasPause?'Tạm dừng — tiến độ đã được lưu':reviewState==='running'?'Đang kiểm tra bản dịch':translationComplete?'Đang chờ kiểm tra':summary.running+summary.completed>0?'Đang dịch và lưu từng chặng':dispatch?'Đang chờ phiên xử lý':'Đã khởi tạo';
    const pausedMessage=shards.find(item=>item?.status==='paused')?.message||currentReview?.message||'Có thể chọn Tiếp tục sau khi giới hạn được làm mới.';
    const steps=[
      step('validate','Kiểm tra tệp',created?.fileValidated?'complete':'active',created?.fileValidated?'Định dạng tệp hợp lệ':'Đang kiểm tra'),
      step('store','Lưu dữ liệu',created?.stored?'complete':created?'active':'waiting',created?.stored?'Đã lưu an toàn':'Đang chờ'),
      step('create','Khởi tạo dự án',created?'complete':'waiting',created?'Đã tạo hồ sơ dự án':'Đang chờ'),
      step('dispatch','Xếp lịch xử lý',dispatch?'complete':'waiting',dispatch?`${workers} phiên tiết kiệm lượt Google`:'Chưa khởi chạy'),
      step('translate','Dịch và lưu từng chặng',isComplete?'complete':summary.failed?'error':summary.paused?'paused':translationComplete?'complete':dispatch?'active':'waiting',workers?`${processedRows}/${Number(project.totalRows)||0} dòng đã lưu · ${summary.completed}/${workers} phiên hoàn tất`:'Đã lưu bản dịch hoàn chỉnh'),
      step('review','Kiểm tra bản dịch',isComplete?'complete':reviewState==='failed'?'error':reviewState==='paused'?'paused':reviewState==='completed'?'complete':translationComplete||reviewState==='running'?'active':'waiting',isComplete?`${Number(effectiveReview.checkedRows||0).toLocaleString('vi-VN')} dòng đã kiểm tra`:reviewState==='paused'?`${Number(currentReview.checkedRows||0)} dòng đã kiểm tra và lưu`:reviewState==='running'?`${reviewPercent}% đã kiểm tra`:'Đang chờ hoàn tất bản dịch'),
      step('complete','Hoàn tất dự án',isComplete?'complete':hasFailure?'error':hasPause?'paused':'waiting',isComplete?'Có thể tải kết quả':hasPause?pausedMessage:'Đang chờ')
    ];
    send(res,200,{project:{...project,progress,status:state,translatedRows:processedRows},state,currentStage,progress,workers,summary,shards:shards.map((item,index)=>item||{index,status:'pending'}),review:effectiveReview,steps,updatedAt:new Date().toISOString()});
  }catch(error){send(res,500,{error:error.message})}
}
