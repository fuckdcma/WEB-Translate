import {allowMethods,envState,github,readProjects,send,writeProjectStatus} from './_shared.js';

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST']))return;
  try{
    if(!envState().github)return send(res,503,{error:'Hãy cấu hình GitHub trên Vercel'});
    if(req.method==='GET'){
      const data=await github('/actions/runs?per_page=20');
      const runs=data.workflow_runs.map(run=>({id:run.id,name:run.name,status:run.status,conclusion:run.conclusion,createdAt:run.created_at,url:run.html_url}));
      return send(res,200,{total:data.total_count,runs});
    }
    const {action,runId:requestedRunId,projectId}=req.body||{};
    if(action==='cancel'){
      const numericRunId=String(requestedRunId||'');
      if(!/^\d+$/.test(numericRunId))return send(res,400,{error:'Mã phiên chạy không hợp lệ'});
      await github(`/actions/runs/${numericRunId}/cancel`,{method:'POST'});
      return send(res,202,{ok:true,runId:Number(numericRunId),message:'Đã yêu cầu dừng phiên cũ'});
    }
    if(!projectId)return send(res,400,{error:'Thiếu mã dự án'});
    const projects=await readProjects();
    const project=projects.find(item=>item.id===String(projectId));
    if(!project)return send(res,404,{error:'Không tìm thấy dự án'});
    const runId=crypto.randomUUID();
    const workflow=encodeURIComponent(process.env.GITHUB_WORKFLOW_FILE||'translate.yml');
    await github(`/actions/workflows/${workflow}/dispatches`,{method:'POST',body:JSON.stringify({ref:process.env.GITHUB_BRANCH||'main',inputs:{project_id:String(projectId),workers:'1',run_id:runId}})});
    try{await writeProjectStatus(String(projectId),'dispatch',{status:'queued',runId,workers:1,requestedWorkers:1,architecture:'quota-queue-v3',queuedAt:new Date().toISOString()})}catch(error){console.error('Không thể lưu trạng thái khởi chạy:',error.message)}
    send(res,202,{ok:true,runId,workers:1,message:'Queue đã khởi chạy với một làn request được kiểm soát quota'});
  }catch(error){send(res,500,{error:error.message})}
}
