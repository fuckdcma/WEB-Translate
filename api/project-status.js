import {allowMethods,readProjects,readProjectStatus,send} from './_shared.js';

const step=(id,label,status,detail)=>({id,label,status,detail});

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET']))return;
  try{
    const projectId=String(req.query?.id||'');
    if(!projectId)return send(res,400,{error:'Thiếu mã dự án'});
    const projects=await readProjects();
    const project=projects.find(item=>item.id===projectId);
    if(!project)return send(res,404,{error:'Không tìm thấy dự án'});

    const [created,dispatch,storedReview]=await Promise.all([
      readProjectStatus(projectId,'project'),
      readProjectStatus(projectId,'dispatch'),
      readProjectStatus(projectId,'review')
    ]);
    const workers=Math.min(16,Math.max(0,Number(dispatch?.workers)||0));
    const storedShards=workers?await Promise.all(Array.from({length:workers},(_,index)=>readProjectStatus(projectId,`shard-${index}`))):[];
    const shards=storedShards.map(item=>item?.runId===dispatch?.runId?item:null);
    const review=storedReview?.runId===dispatch?.runId?storedReview:null;
    const summary={pending:0,running:0,completed:0,failed:0};
    for(const shard of shards){
      const state=shard?.status||'pending';
      if(state in summary)summary[state]+=1;else summary.pending+=1;
    }
    const translationComplete=workers>0&&summary.completed===workers;
    const hasTranslationActivity=summary.running+summary.completed+summary.failed>0;
    const reviewState=review?.status||'waiting';
    const hasFailure=summary.failed>0||reviewState==='failed';
    const isComplete=translationComplete&&reviewState==='completed';
    const translationPercent=workers?Math.round(summary.completed/workers*100):0;
    const progress=isComplete?100:hasFailure?Math.min(95,20+Math.round(translationPercent*.65)):reviewState==='running'?90:translationComplete?85:dispatch?20+Math.round(translationPercent*.65):created?15:0;
    const currentStage=isComplete?'Hoàn thành':hasFailure?'Cần kiểm tra':reviewState==='running'?'Đang kiểm tra bản dịch':translationComplete?'Đang chờ kiểm tra':hasTranslationActivity?'Đang dịch song song':dispatch?'Đang chờ phiên xử lý':'Đã khởi tạo';
    const steps=[
      step('validate','Kiểm tra tệp',created?.fileValidated?'complete':'active',created?.fileValidated?'Định dạng tệp hợp lệ':'Đang kiểm tra'),
      step('store','Lưu dữ liệu',created?.stored?'complete':created?'active':'waiting',created?.stored?'Đã lưu an toàn':'Đang chờ'),
      step('create','Khởi tạo dự án',created?'complete':'waiting',created?'Đã tạo hồ sơ dự án':'Đang chờ'),
      step('dispatch','Xếp lịch xử lý',dispatch?'complete':'waiting',dispatch?`${workers} phiên đã được xếp lịch`:'Chưa khởi chạy'),
      step('translate','Dịch song song',hasFailure&&summary.failed?'error':translationComplete?'complete':dispatch?'active':'waiting',workers?`${summary.completed}/${workers} phiên hoàn tất${summary.running?` · ${summary.running} đang chạy`:''}`:'Đang chờ'),
      step('review','Kiểm tra bản dịch',reviewState==='failed'?'error':reviewState==='completed'?'complete':translationComplete||reviewState==='running'?'active':'waiting',reviewState==='completed'?`${Number(review.checkedRows||0).toLocaleString('vi-VN')} dòng đã kiểm tra`:reviewState==='running'?`${Number(review.progress||0)}% đã kiểm tra`:'Đang chờ hoàn tất bản dịch'),
      step('complete','Hoàn tất dự án',isComplete?'complete':hasFailure?'error':'waiting',isComplete?'Có thể tải kết quả':'Đang chờ')
    ];
    send(res,200,{project:{...project,progress,status:isComplete?'done':'working',translatedRows:Math.round(Number(project.totalRows||0)*translationPercent/100)},currentStage,progress,workers,summary,shards:shards.map((item,index)=>item||{index,status:'pending'}),review,steps,updatedAt:new Date().toISOString()});
  }catch(error){send(res,500,{error:error.message})}
}
