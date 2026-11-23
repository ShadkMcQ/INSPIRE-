import { getStore, connectLambda } from '@netlify/blobs';
import { randomBytes, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const json=(status,data)=>({statusCode:status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(data)});
const error=(s,m)=>json(s,{error:m});
const clean=(v,n=1200)=>String(v??'').trim().slice(0,n);
const validTypes=['reflection','wordcloud','poll','quiz','qa','scale'];
const validVisibility=['private','moderated','live'];
const validIdentity=['anonymous','optional','named'];
const secret=()=>null;
const key=()=>process.env.INSPIRE_SESSION_SECRET || process.env.INSPIRE_ADMIN_PASSWORD;
const sign=(s)=>createHmac('sha256',key()).update(s).digest('hex');
const token=()=>{const payload=Buffer.from(JSON.stringify({exp:Date.now()+12*60*60*1000,nonce:randomBytes(8).toString('hex')})).toString('base64url');return payload+'.'+sign(payload)};
function authorized(ev){const t=(ev.headers.authorization||ev.headers.Authorization||'').replace(/^Bearer\s+/i,'');const [payload,sig]=t.split('.');if(!payload||!sig||!key())return false;const expected=sign(payload);if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;try{return JSON.parse(Buffer.from(payload,'base64url').toString()).exp>Date.now()}catch{return false}}
const store=()=>getStore('inspire-events');
const ekey=(code)=>`event-${code}`;
const rkey=(code,q,p)=>`response-${code}-${q}-${p}`;
async function getEvent(db,code){return await db.get(ekey(clean(code,16).toUpperCase()),{type:'json'});}
async function getResponses(db,code){const prefix=`response-${code}-`;let cursor;const out=[];do{const page=await db.list({prefix,cursor,paginate:true});for(const x of page.blobs){const row=await db.get(x.key,{type:'json'});if(row)out.push(row)}cursor=page.cursor;}while(cursor);return out.sort((a,b)=>b.created_at.localeCompare(a.created_at));}
const publicQuestion=q=>q&&({id:q.id,title:q.title,type:q.type,options:q.options,visibility:q.visibility,identity_mode:q.identity_mode,status:q.status,sort_order:q.sort_order});
function seed(){return [
 {type:'reflection',title:'Where in my leadership am I relying on an old pattern that no longer serves the leader I am becoming?',visibility:'private',identity_mode:'anonymous'},
 {type:'reflection',title:'What value or purpose do I want to guide my next leadership decision, and what would that look like in practice?',visibility:'private',identity_mode:'anonymous'},
 {type:'reflection',title:'What is one courageous, specific action I will take in the next seven days to lead more in line with that value?',visibility:'private',identity_mode:'anonymous'},
 {type:'wordcloud',title:'In one word, what does coming up higher mean to you?',visibility:'moderated',identity_mode:'anonymous'},
 {type:'qa',title:'What would you like to ask Marsha?',visibility:'moderated',identity_mode:'optional'}
 ].map((q,i)=>({...q,id:randomUUID(),event_id:'INSPIRE26',options:[],status:'draft',sort_order:i,correct_index:null}));}
export async function handler(ev){
 connectLambda(ev);

 if(ev.httpMethod==='OPTIONS')return json(200,{});

 const path=decodeURIComponent((ev.path||'').split('/').pop());const method=ev.httpMethod;
 let body={};try{body=JSON.parse(ev.body||'{}')}catch{return error(400,'Invalid JSON')}
 const query=ev.queryStringParameters||{};
 try{
  const db=store();
  if(path==='login'&&method==='POST'){
   const candidate=clean(body.password,300);const expected=secret();const a=createHmac('sha256','inspire-login').update(candidate).digest();const b=createHmac('sha256','inspire-login').update(expected).digest();if(!timingSafeEqual(a,b))return error(401,'Incorrect facilitator password');return json(200,{token:token()});
  }
  if(path==='join'&&method==='GET'){
   const e=await getEvent(db,query.code);if(!e)return error(404,'Event not found');const q=e.questions.find(q=>q.id===e.active_question_id&&q.status==='active');return json(200,{event:{id:e.id,title:e.title,code:e.code,active_question_id:e.active_question_id},question:publicQuestion(q)});
  }
  if(path==='submit'&&method==='POST'){
   const e=await getEvent(db,body.code);if(!e)return error(404,'Event not found');const q=e.questions.find(x=>x.id===body.question_id&&x.id===e.active_question_id&&x.status==='active');if(!q)return error(409,'Question is no longer active');
   const participant=clean(body.participant_id,100),answer=clean(body.answer,1200),name=clean(body.name,80);
   if(!/^[a-zA-Z0-9_-]{12,100}$/.test(participant)||!answer)return error(400,'Missing response or participant ID');
   if(q.identity_mode==='named'&&!name)return error(400,'Your name is required');
   if(['poll','quiz'].includes(q.type)&&q.options.length>0&&!q.options.includes(answer))return error(400,'Choose a valid answer');
   if(q.type==='scale'&&!/^([1-9]|10)$/.test(answer))return error(400,'Choose 1–10');
   const old=await db.get(rkey(e.code,q.id,participant),{type:'json'});
   const isCorrect=q.type==='quiz'&&(q.options.length>0?answer===q.options[q.correct_index]:answer.toLocaleLowerCase()===String(q.correct_answer||'').trim().toLocaleLowerCase());const row={score:q.type==='quiz'?(isCorrect?1:0):null,id:old?.id||randomUUID(),event_id:e.id,question_id:q.id,participant_id:participant,answer,display_name:q.identity_mode==='anonymous'?null:name||null,approved:q.visibility==='live',featured:old?.featured||false,created_at:old?.created_at||new Date().toISOString()};
   await db.setJSON(rkey(e.code,q.id,participant),row);return json(200,{ok:true,score:row.score});
  }
  if(path==='upvote'&&method==='POST'){const e=await getEvent(db,body.code);if(!e)return error(404,'Event not found');const q=e.questions.find(x=>x.id===body.question_id&&x.type==='qa');if(!q)return error(404,'Q&A question not found');const pid=clean(body.participant_id,100);if(!/^[a-zA-Z0-9_-]{12,100}$/.test(pid))return error(400,'Invalid participant');const rows=await getResponses(db,e.code);const row=rows.find(x=>x.id===body.response_id&&x.question_id===q.id);if(!row)return error(404,'Question response not found');const k=`vote-${e.code}-${q.id}-${row.id}-${pid}`;if(await db.get(k))return json(200,{ok:true,already_voted:true});await db.set(k,'1');const countKey=`votes-${e.code}-${q.id}-${row.id}`;const count=Number(await db.get(countKey)||0)+1;await db.set(countKey,String(count));return json(200,{ok:true,votes:count})}
  if(path==='wall'&&method==='GET'){
   const e=await getEvent(db,query.code);if(!e)return error(404,'Event not found');const q=e.questions.find(x=>x.id===e.active_question_id&&x.status==='active');if(!q)return json(200,{question:null,responses:[],total:0});const rows=(await getResponses(db,e.code)).filter(x=>x.question_id===q.id);return json(200,{question:publicQuestion(q),responses:q.visibility==='private'?[]:rows.filter(x=>x.approved).map(x=>({id:x.id,answer:x.answer,display_name:x.display_name,featured:x.featured})),total:rows.length});
  }
  // Open facilitator mode as requested: anyone with its URL can manage the event.
  if(path==='events'&&method==='GET'){
   let e=await getEvent(db,'INSPIRE26');if(!e){e={id:'INSPIRE26',code:'INSPIRE26',title:'INSPIRE — Come Up Higher',active_question_id:null,questions:seed(),created_at:new Date().toISOString()};await db.setJSON(ekey(e.code),e)}return json(200,{events:[{id:e.id,title:e.title,code:e.code,active_question_id:e.active_question_id}]});
  }
  if(path==='events'&&method==='POST'){
   const existing=await getEvent(db,'INSPIRE26');if(existing)return json(200,{event:existing});const e={id:'INSPIRE26',code:'INSPIRE26',title:clean(body.title,120)||'INSPIRE — Come Up Higher',active_question_id:null,questions:seed(),created_at:new Date().toISOString()};await db.setJSON(ekey(e.code),e);return json(200,{event:e});
  }
  const e=await getEvent(db,body.event_id||query.event_id);if(!e)return error(404,'Event not found');
  if(path==='dashboard'&&method==='GET'){const rows=await getResponses(db,e.code);const responses=await Promise.all(rows.map(async r=>({...r,votes:Number(await db.get(`votes-${e.code}-${r.question_id}-${r.id}`)||0)})));const leaderboard=Object.values(responses.filter(r=>r.score!==null).reduce((a,r)=>{const k=r.participant_id;if(!a[k])a[k]={name:r.display_name||'Participant '+k.slice(-4),points:0};a[k].points+=r.score||0;return a},{})).sort((a,b)=>b.points-a.points);return json(200,{event:{id:e.id,code:e.code,title:e.title,active_question_id:e.active_question_id},questions:e.questions,responses,leaderboard})}
  if(path==='question'&&method==='POST'){
   const type=clean(body.type,20),visibility=clean(body.visibility,20),identity_mode=clean(body.identity_mode,20),title=clean(body.title,400);
   if(!title||!validTypes.includes(type)||!validVisibility.includes(visibility)||!validIdentity.includes(identity_mode))return error(400,'Invalid question settings');
   const payload={title,type,visibility,identity_mode,options:Array.isArray(body.options)?body.options.slice(0,12).map(x=>clean(x,120)).filter(Boolean):[],correct_index:Number.isInteger(body.correct_index)?body.correct_index:null,correct_answer:clean(body.correct_answer,120),sort_order:Number.isInteger(body.sort_order)?body.sort_order:e.questions.length};
   // Zero choices means free-text poll or quiz; one choice is also supported.
   if(type==='quiz'&&payload.options.length>0&&(payload.correct_index===null||payload.correct_index<0||payload.correct_index>=payload.options.length))return error(400,'Select the correct answer index for this quiz');if(type==='quiz'&&payload.options.length===0&&!payload.correct_answer)return error(400,'Enter a correct answer for the open-text quiz');
   if(body.id){const q=e.questions.find(x=>x.id===body.id);if(!q)return error(404,'Question not found');Object.assign(q,payload)}else{e.questions.push({...payload,id:randomUUID(),event_id:e.id,status:'draft'})}
   await db.setJSON(ekey(e.code),e);return json(200,{ok:true});
  }
  if(path==='activate'&&method==='POST'){
   if(body.question_id&&!e.questions.some(x=>x.id===body.question_id))return error(404,'Question not found');e.questions.forEach(x=>{if(x.status==='active')x.status='closed';if(x.id===body.question_id)x.status='active'});e.active_question_id=body.question_id||null;await db.setJSON(ekey(e.code),e);return json(200,{ok:true});
  }
  if(path==='moderate'&&method==='POST'){
   const rows=await getResponses(db,e.code);const row=rows.find(x=>x.id===body.response_id);if(!row)return error(404,'Response not found');if(typeof body.approved==='boolean')row.approved=body.approved;if(typeof body.featured==='boolean')row.featured=body.featured;await db.setJSON(rkey(e.code,row.question_id,row.participant_id),row);return json(200,{ok:true});
  }
  if(path==='delete-question'&&method==='POST'){
   const q=e.questions.find(x=>x.id===body.question_id);if(!q)return error(404,'Question not found');if(q.status==='active')return error(409,'Close question before deleting');e.questions=e.questions.filter(x=>x.id!==q.id);await db.setJSON(ekey(e.code),e);const rows=(await getResponses(db,e.code)).filter(x=>x.question_id===q.id);for(const row of rows)await db.delete(rkey(e.code,row.question_id,row.participant_id));return json(200,{ok:true});
  }
  return error(404,'Unknown endpoint');
 }catch(e){console.error('INSPIRE API error',e);return error(500,'Server error. Check Netlify function logs.');}
}
