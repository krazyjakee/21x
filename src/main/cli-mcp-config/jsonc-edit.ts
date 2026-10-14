import { stripJsonComments, type JsonDocument } from './file-store'
interface Property { key:string; start:number; value:Node; comma?:number }
interface Node { start:number; end:number; properties?:Property[] }
interface Edit { start:number; end:number; text:string }
/** Small bounded syntax index. Unknown sections and every comment remain byte
 * text; only changed managed leaves are replaced. Duplicate keys are refused. */
class Index {
  position=0; tokens=0; readonly comments:Array<{start:number;end:number}>=[]
  constructor(readonly source:string){}
  space():void{for(;;){while(/\s/.test(this.source[this.position]??'')&&this.position<this.source.length)this.position++
    const start=this.position
    if(this.source.startsWith('//',start)){while(this.position<this.source.length&&this.source[this.position]!=='\n')this.position++;this.comments.push({start,end:this.position})}
    else if(this.source.startsWith('/*',start)){const end=this.source.indexOf('*/',start+2);if(end<0)throw new Error('CLI_MCP_JSON_INVALID');this.position=end+2;this.comments.push({start,end:this.position})}else return
  }}
  string():string{const start=this.position++;while(this.position<this.source.length){const c=this.source[this.position++];if(c==='\\')this.position++;else if(c==='"')return JSON.parse(this.source.slice(start,this.position)) as string}throw new Error('CLI_MCP_JSON_INVALID')}
  value(depth=0):Node{this.space();if(depth>64||++this.tokens>32768)throw new Error('CLI_MCP_JSON_LIMIT');const start=this.position,c=this.source[this.position]
    if(c==='"')this.string()
    else if(c==='{'){this.position++;const properties:Property[]=[],keys=new Set<string>();this.space()
      while(this.source[this.position]!=='}'){if(this.source[this.position]!=='"')throw new Error('CLI_MCP_JSON_INVALID');const p=this.position,key=this.string();if(keys.has(key))throw new Error('CLI_MCP_JSON_AMBIGUOUS');keys.add(key);this.space();if(this.source[this.position++]!==':')throw new Error('CLI_MCP_JSON_INVALID');const value=this.value(depth+1);this.space();const property:Property={key,start:p,value};if(this.source[this.position]===','){property.comma=this.position++;this.space()}else if(this.source[this.position]!=='}')throw new Error('CLI_MCP_JSON_INVALID');properties.push(property)}
      this.position++;return {start,end:this.position,properties}
    }else if(c==='['){this.position++;this.space();while(this.source[this.position]!==']'){this.value(depth+1);this.space();if(this.source[this.position]===','){this.position++;this.space()}else if(this.source[this.position]!==']')throw new Error('CLI_MCP_JSON_INVALID')}this.position++}
    else {const scalar=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(this.source.slice(this.position));if(!scalar)throw new Error('CLI_MCP_JSON_INVALID');this.position+=scalar[0].length}
    return {start,end:this.position}
  }
}
export function validatePortableJsonText(source:string):void {if(!source.trim())return;const parser=new Index(source);parser.value();parser.space();if(parser.position!==source.length)throw new Error('CLI_MCP_JSON_INVALID')}
export function preserveJsonDocument(doc:JsonDocument,original:string):string {
  if(!original.trim())return JSON.stringify(doc.value,null,doc.indent)+'\n'
  const parser=new Index(original),root=parser.value();parser.space();if(parser.position!==original.length)throw new Error('CLI_MCP_JSON_INVALID')
  const previous=JSON.parse((doc as JsonDocument & { originalJson?:string }).originalJson!) as unknown,edits:Edit[]=[]
  const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
  const comments=(node:Node):string=>parser.comments.filter(comment=>comment.start>=node.start&&comment.end<=node.end).map(comment=>original.slice(comment.start,comment.end)+'\n').join('')
  const walk=(node:Node,before:unknown,after:unknown):void=>{
    if(JSON.stringify(before)===JSON.stringify(after))return
    if(node.properties&&object(before)&&object(after)){
      const kept=node.properties.filter(property=>Object.hasOwn(after,property.key)),removed=node.properties.filter(property=>!Object.hasOwn(after,property.key))
      const commaDeletes=new Set<number>()
      for(const property of removed){edits.push({start:property.start,end:property.value.end,text:comments(property.value)});if(property.comma!==undefined)commaDeletes.add(property.comma)}
      // The final retained property cannot keep its separator if every later
      // property was removed; trailing commas are allowed, so keeping it is safe.
      for(const comma of commaDeletes)edits.push({start:comma,end:comma+1,text:''})
      for(const property of kept)walk(property.value,before[property.key],after[property.key])
      const added=Object.keys(after).filter(key=>!Object.hasOwn(before,key))
      if(added.length){const last=kept.at(-1);if(last&&last.comma===undefined)edits.push({start:last.value.end,end:last.value.end,text:','});const indent=typeof doc.indent==='number'?' '.repeat(doc.indent):doc.indent
        edits.push({start:node.end-1,end:node.end-1,text:'\n'+added.map(key=>indent+JSON.stringify(key)+': '+JSON.stringify(after[key])).join(',\n')+'\n'})}
    }else edits.push({start:node.start,end:node.end,text:comments(node)+JSON.stringify(after)})
  }
  walk(root,previous,doc.value);let output=original
  for(const edit of edits.map((edit,index)=>({...edit,index})).sort((a,b)=>b.start-a.start||b.end-a.end||b.index-a.index))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end)
  validatePortableJsonText(output)
  // Verify the edit really represents the intended object, with no lost keys.
  const canonical=(value:unknown):string => Array.isArray(value)?'['+value.map(canonical).join(',')+']':object(value)?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value)
  if(canonical(JSON.parse(stripJsonComments(output).text.trimStart()))!==canonical(doc.value))throw new Error('CLI_MCP_JSON_EDIT_MISMATCH')
  return output
}
