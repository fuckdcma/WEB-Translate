import {downloadFile,listFiles,uploadFiles} from '@huggingface/hub';
import {sleep} from './google-api.mjs';

export const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
export const accessToken=process.env.HF_TOKEN;

export class StoragePauseError extends Error{constructor(message){super(message);this.name='StoragePauseError'}}

function storageWait(error){
  if(Number(error?.statusCode)!==429&&!/rate limit for repository commits/i.test(String(error)))return 0;
  const minutes=Number(String(error).match(/retry this action in (\d+) minutes?/i)?.[1]);
  return (Number.isFinite(minutes)&&minutes>0?minutes:2)*60_000+10_000;
}

export async function readFile(path){try{return await downloadFile({repo,path,accessToken})}catch(error){if(String(error).includes('404'))return null;throw error}}
export async function readText(path){const response=await readFile(path);return response?response.text():null}
export async function readJson(path){const response=await readFile(path);return response?JSON.parse(await response.text()):null}
export async function listPaths(prefix=''){const paths=[];for await(const entry of listFiles({repo,accessToken,recursive:true}))if(entry.type==='file'&&entry.path.startsWith(prefix))paths.push(entry.path);return paths}
export const jsonFile=(path,data)=>({path,content:new Blob([JSON.stringify(data,null,2)],{type:'application/json'})});
export const textFile=(path,content,type='text/tab-separated-values')=>({path,content:new Blob([content],{type})});

export async function uploadWithRetry(files){
  let lastError;
  for(let attempt=1;attempt<=3;attempt+=1)try{await uploadFiles({repo,accessToken,files});return}catch(error){lastError=error;const wait=storageWait(error);if(wait&&attempt<3){console.warn(`Hugging Face commit limit reached; waiting ${Math.ceil(wait/60_000)} minutes`);await sleep(wait);continue}if(wait)break;if(attempt<3)await sleep(800*attempt+Math.round(Math.random()*500))}
  if(storageWait(lastError))throw new StoragePauseError('Hugging Face đang giới hạn số lần lưu. Phiên đã dừng an toàn và có thể tiếp tục sau.');
  throw lastError;
}
