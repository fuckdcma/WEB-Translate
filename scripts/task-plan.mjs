export function categoryFor(key,text){
  const value=`${key} ${text}`.toLowerCase();
  if(/menu|option|setting|ui[\/_-]|button|label|title|header|credit|inventory|item|skill|weapon|pause|screen/.test(value))return'menu';
  if(/interact|prompt|confirm|cancel|quest|objective|achievement|unlock|condition|tutorial|hint|action|error|warning|notification/.test(value))return'interaction';
  return'story';
}

export function buildTaskPlan(items){
  const taskSize=items.length<=100?10:items.length<=500?25:50;const groups={menu:[],interaction:[],story:[]};
  items.forEach((item,index)=>groups[categoryFor(item.key,item.text)].push(index));const tasks=[];let sequence=0;
  for(const category of ['menu','interaction','story'])for(let offset=0;offset<groups[category].length;offset+=taskSize){const rowIndexes=groups[category].slice(offset,offset+taskSize);tasks.push({id:`${category}-${String(Math.floor(offset/taskSize)+1).padStart(4,'0')}`,sequence:sequence++,category,rowIndexes,rowCount:rowIndexes.length})}
  return{taskSize,tasks,categories:Object.fromEntries(Object.entries(groups).map(([name,indexes])=>[name,indexes.length]))};
}
