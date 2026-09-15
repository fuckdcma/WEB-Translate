import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fetchGoogleQuotaSnapshot} from './google-cloud-monitor.mjs';

const projectId=process.env.GOOGLE_CLOUD_PROJECT_ID||'gen-lang-client-0420200295';
const projectNumber=process.env.GOOGLE_CLOUD_PROJECT_NUMBER||'474948213416';
const endpoint=process.env.QUOTA_MONITOR_ENDPOINT||'https://web-translate-five.vercel.app/api/quota-observation';
const gcloud=process.env.GCLOUD_PATH||join(process.env.LOCALAPPDATA||'', 'Google','Cloud SDK','google-cloud-sdk','bin','gcloud.cmd');
const secretFile=process.env.QUOTA_MONITOR_SECRET_FILE||join(process.env.LOCALAPPDATA||'', 'WEBTranslate','quota-monitor-secret.txt');

const accessToken=execFileSync(gcloud,['auth','print-access-token'],{encoding:'utf8',windowsHide:true}).trim();
if(!accessToken)throw new Error('Google chưa đăng nhập trên máy');
process.env.GOOGLE_CLOUD_PROJECT_ID=projectId;process.env.GOOGLE_CLOUD_PROJECT_NUMBER=projectNumber;process.env.GOOGLE_CLOUD_ACCESS_TOKEN=accessToken;
const [secret,snapshot]=await Promise.all([readFile(secretFile,'utf8').then(value=>value.trim()),fetchGoogleQuotaSnapshot()]);
const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(60_000)});
if(!response.ok)throw new Error(`Website từ chối bản đối chứng (${response.status}): ${(await response.text()).slice(0,240)}`);
const result=await response.json();console.log(`Google quota synced at ${result.receivedAt}; ${result.models} models recorded.`);
