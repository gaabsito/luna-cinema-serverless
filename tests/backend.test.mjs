import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../backend/core.mjs';
const valid = {name:'Prueba Cine', email:'cine@example.com', interest:'clasicos', consent:true, requestId:'526770f0-f7e0-4aee-8073-89fbc1f4d6aa'};
function fixture({failPublish=false}={}) {
 const items=new Map(); let publications=0;
 const store={create:async i=>{const old=items.get(i.id);if(old)return {created:false,item:old};items.set(i.id,{...i});return {created:true,item:items.get(i.id)};},claim:async id=>{const i=items.get(id);if(i.lease)return null;i.lease='token';return 'token';},sent:async(id,token,msg)=>{Object.assign(items.get(id),{notificationStatus:'sent',snsMessageId:msg});delete items.get(id).lease;},release:async id=>{delete items.get(id).lease;}};
 const handler=createHandler({store,publish:async()=>{if(failPublish)throw new Error('SNS unavailable');publications++;return {MessageId:'message-1'};},log:{info(){},error(){}}});
 return {items,handler,publications:()=>publications};
}
const event=data=>({requestContext:{http:{method:'POST'}},body:JSON.stringify(data)});
test('Persiste y publica; el reintento no duplica inscripción ni SNS',async()=>{const f=fixture();assert.equal((await f.handler(event(valid))).statusCode,201);assert.equal((await f.handler(event(valid))).statusCode,200);assert.equal(f.items.size,1);assert.equal(f.publications(),1);assert.equal(f.items.get(valid.requestId).notificationStatus,'sent');});
test('Validación impide efectos externos',async()=>{for(const patch of [{name:' '},{email:'no-es-email'},{interest:'otro'},{consent:false},{requestId:'bad'}]){const f=fixture();assert.equal((await f.handler(event({...valid,...patch}))).statusCode,400);assert.equal(f.items.size,0);assert.equal(f.publications(),0);}});
test('Fallo SNS conserva datos y nunca comunica éxito',async()=>{const f=fixture({failPublish:true});const result=await f.handler(event(valid));assert.equal(result.statusCode,503);assert.equal(JSON.parse(result.body).notified,false);assert.equal(f.items.size,1);assert.equal(f.items.get(valid.requestId).notificationStatus,'pending');assert.equal(f.items.get(valid.requestId).lease,undefined);});
test('Identificador repetido con datos diferentes devuelve conflicto',async()=>{const f=fixture();await f.handler(event(valid));assert.equal((await f.handler(event({...valid,email:'otro@example.com'}))).statusCode,409);assert.equal(f.publications(),1);});
test('JSON malformado y método incorrecto no acceden a AWS',async()=>{const f=fixture();assert.equal((await f.handler({httpMethod:'POST',body:'{'})).statusCode,400);assert.equal((await f.handler({httpMethod:'GET'})).statusCode,405);assert.equal(f.items.size,0);});
test('Acepta evento API Gateway con cuerpo base64 y normaliza email',async()=>{const f=fixture();const e=event({...valid,email:' CINE@EXAMPLE.COM '});e.body=Buffer.from(e.body).toString('base64');e.isBase64Encoded=true;assert.equal((await f.handler(e)).statusCode,201);assert.equal(f.items.get(valid.requestId).email,'cine@example.com');});
