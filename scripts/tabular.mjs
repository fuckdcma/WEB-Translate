export function parseDelimited(content,delimiter){
  const rows=[];let row=[],value='',quoted=false;
  for(let index=0;index<content.length;index+=1){
    const char=content[index];
    if(char==='"'){if(quoted&&content[index+1]==='"'){value+='"';index+=1}else quoted=!quoted}
    else if(char===delimiter&&!quoted){row.push(value);value=''}
    else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&content[index+1]==='\n')index+=1;row.push(value);if(row.some(cell=>cell!==''))rows.push(row);row=[];value=''}
    else value+=char;
  }
  row.push(value);if(row.some(cell=>cell!==''))rows.push(row);return rows;
}

export function serializeDelimited(rows,delimiter){
  const encode=value=>{const text=String(value??'');return text.includes(delimiter)||/["\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text};
  return rows.map(row=>row.map(encode).join(delimiter)).join('\n');
}

export function detectColumns(rows){
  const header=rows[0]||[];
  let target=header.findIndex(column=>/^(vietnamese|vi|translation)$/i.test(String(column).trim()));
  if(target<0){target=header.length;header.push('Vietnamese');for(let index=1;index<rows.length;index+=1)rows[index][target]=''}
  const source=header.findIndex((column,index)=>index!==target&&/^(languages?|source|english|text|original)$/i.test(String(column).trim()));
  return{key:0,target,source:source>=0?source:Math.min(1,Math.max(0,header.length-1))};
}
