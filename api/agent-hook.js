import {timingSafeEqual} from 'node:crypto';
import {allowMethods,geminiPlatform,readAgentRun,send,writeAgentRun} from './_shared.js';

function authorized(req){
  const expected=process.env.AGENT_HOOK_SECRET||process.env.QUOTA_MONITOR_INGEST_SECRET||'';
  const actual=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const a=Buffer.from(actual),b=Buffer.from(expected);return Boolean(expected&&a.length===b.length&&timingSafeEqual(a,b));
}
function describe(body){
  const call=body?.tool_call||{};const args=JSON.stringify(call.args||{});const error=body?.error;
  if(error)return {stage:'failed',status:'failed',detail:String(error).slice(0,220)};
  if(/pnpm install/.test(args))return {stage:'installing',detail:'Đã chuẩn bị bộ xử lý'};
  if(/coordinate-project/.test(args))return {stage:'coordinating',detail:'Đã chia và phân công tác vụ'};
  if(/analyze-project/.test(args))return {stage:'analyzing',detail:'Đã phân loại nội dung và thuật ngữ'};
  if(/translate-worker/.test(args))return {stage:'translating',detail:'Đã lưu thêm một checkpoint bản dịch'};
  if(/review-project/.test(args))return {stage:'reviewing',detail:'Đã chạy bước kiểm tra cuối'};
  if(call.name==='read_file')return {stage:'reading',detail:'Đang đọc tệp nguồn'};
  if(call.name==='write_file')return {stage:'writing',detail:'Đang ghi kết quả'};
  return {stage:'working',detail:`Đã hoàn tất ${call.name||'một bước xử lý'}`};
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['POST']))return;
  if(!authorized(req))return send(res,401,{});
  const runId=String(req.headers['x-agent-run']||'');const projectId=String(req.headers['x-project-id']||'');
  if(!runId||!projectId)return send(res,200,{});
  try{
    const run=await readAgentRun(runId);if(!run||run.projectId!==projectId)return send(res,200,{});
    const update=describe(typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}));const occurredAt=new Date().toISOString();
    const event={...update,tool:req.body?.tool_call?.name||null,occurredAt};
    const next={...run,...update,status:update.status||'in_progress',currentFile:run.sourceFile,environmentId:req.body?.environment_id||run.environmentId,updatedAt:occurredAt,events:[event,...(run.events||[])].slice(0,30)};
    if(update.stage==='reviewing'){
      next.status='completed';next.stage='completed';next.detail='Đã dịch và kiểm tra hoàn tất';next.completedAt=occurredAt;
      if(next.triggerId)try{await geminiPlatform(`/triggers/${encodeURIComponent(next.triggerId)}`,{method:'PATCH',body:JSON.stringify({status:'paused'})});next.triggerStatus='paused'}catch(error){next.warning=error.message}
    }
    await writeAgentRun(next);
  }catch(error){console.error('agent-hook',error)}
  send(res,200,{})
}
