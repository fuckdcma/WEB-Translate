const retryableStatuses=new Set([408,429,500,502,503,504]);
const maxAttempts=Math.min(4,Math.max(1,Number(process.env.GEMINI_MAX_ATTEMPTS)||4));

export const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

export class GooglePauseError extends Error{
  constructor(message,{reason='service_busy',attempts=1,status=0}={}){
    super(message);
    this.name='GooglePauseError';
    this.reason=reason;
    this.attempts=attempts;
    this.status=status;
  }
}

function isDailyQuota(detail){return /daily|per[ _-]?day|requests?[ _-]?per[ _-]?day|\brpd\b|GenerateRequestsPerDay/i.test(detail)}

function retryDelay(response,attempt){
  const retryAfterSeconds=Number(response?.headers?.get('retry-after'));
  if(Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0)return Math.min(60_000,retryAfterSeconds*1000);
  return Math.min(60_000,2_000*2**(attempt-1))+Math.round(Math.random()*1_500);
}

export async function requestGoogle({prompt,temperature=0.1,label='Google AI',model=process.env.GEMINI_MODEL||'gemini-3.6-flash'}){
  const googleUrl=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    let response;
    try{
      response=await fetch(googleUrl,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{candidateCount:1,responseMimeType:'application/json',temperature,maxOutputTokens:65_536}}),signal:AbortSignal.timeout(300_000)});
    }catch(error){
      if(attempt===maxAttempts)throw new GooglePauseError(`${label} tạm thời mất kết nối. Tiến độ đã được lưu.`,{reason:'network',attempts:attempt});
      const delay=retryDelay(null,attempt);
      console.warn(`${label}: lỗi kết nối, chờ ${delay}ms trước lần thử ${attempt+1}/${maxAttempts}`);
      await sleep(delay);
      continue;
    }

    if(response.ok)return{payload:await response.json(),attempts:attempt};
    const detail=await response.text();
    if(response.status===429&&isDailyQuota(detail))throw new GooglePauseError(`${label} đã chạm giới hạn lượt dùng hôm nay. Tiến độ đã được lưu để chạy tiếp sau khi giới hạn được làm mới.`,{reason:'daily_quota',attempts:attempt,status:429});
    if(!retryableStatuses.has(response.status))throw new Error(`${label} request failed: ${response.status} ${detail}`);
    if(attempt===maxAttempts)throw new GooglePauseError(`${label} đang bận. Tiến độ đã được lưu để chạy tiếp.`,{reason:response.status===429?'rate_limit':'service_busy',attempts:attempt,status:response.status});
    const delay=retryDelay(response,attempt);
    console.warn(`${label}: nhận mã ${response.status}, chờ ${delay}ms trước lần thử ${attempt+1}/${maxAttempts}`);
    await sleep(delay);
  }
  throw new GooglePauseError(`${label} đang bận. Tiến độ đã được lưu để chạy tiếp.`);
}

export function makeBatches(items,serialize,{maxRows=1_000,maxChars=160_000}={}){
  const batches=[];
  let batch=[];
  let chars=0;
  for(const item of items){
    const itemChars=JSON.stringify(serialize(item)).length+1;
    if(batch.length&&(batch.length>=maxRows||chars+itemChars>maxChars)){batches.push(batch);batch=[];chars=0}
    batch.push(item);
    chars+=itemChars;
  }
  if(batch.length)batches.push(batch);
  return batches;
}
