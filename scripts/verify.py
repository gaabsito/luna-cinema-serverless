#!/usr/bin/env python3
"""Prueba real independiente del navegador; guarda evidencia sin credenciales."""
import json, subprocess, uuid, urllib.request, urllib.error, datetime
from pathlib import Path
root=Path(__file__).resolve().parents[1]
state=json.loads((root/'scripts'/'state.json').read_text())
def aws(service,operation,**kwargs):
 cmd=['aws',service,operation,'--region',state['region'],'--output','json','--no-cli-pager']
 for k,v in kwargs.items():cmd.extend(['--'+k.replace('_','-'),json.dumps(v) if isinstance(v,(dict,list)) else str(v)])
 return json.loads(subprocess.check_output(cmd,text=True))
def post(payload):
 request=urllib.request.Request(state['apiUrl'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Origin':'https://gaabsito.github.io'},method='POST')
 try:
  with urllib.request.urlopen(request,timeout=30) as r:return r.status,json.load(r),r.headers.get('Access-Control-Allow-Origin')
 except urllib.error.HTTPError as e:return e.code,json.load(e),e.headers.get('Access-Control-Allow-Origin')
id=str(uuid.uuid4());payload={'name':'Prueba API Luna Cinema','email':'cine@example.com','interest':'clasicos','consent':True,'requestId':id}
code,result,cors=post(payload)
assert code==201 and result['notified'] is True,(code,result)
code2,result2,_=post(payload);assert code2==200 and result2['id']==id
invalid,_,_=post({**payload,'email':'no-valido','requestId':str(uuid.uuid4())});assert invalid==400
item=aws('dynamodb','get-item',table_name=state['table'],key={'id':{'S':id}},consistent_read=True) if False else json.loads(subprocess.check_output(['aws','dynamodb','get-item','--table-name',state['table'],'--key',json.dumps({'id':{'S':id}}),'--consistent-read','--region',state['region'],'--output','json'],text=True))
assert item['Item']['notificationStatus']['S']=='sent'
subscriptions=aws('sns','list-subscriptions-by-topic',topic_arn=state['topicArn'])['Subscriptions']
confirmed=any(s['SubscriptionArn']!='PendingConfirmation' for s in subscriptions);assert confirmed
logs=aws('logs','filter-log-events',log_group_name='/aws/lambda/'+state['function'],filter_pattern='"'+id+'"')
evidence={'testedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'requestId':id,'postStatus':code,'retryStatus':code2,'invalidEmailStatus':invalid,'corsOrigin':cors,'apiResponse':result,'dynamoItem':item['Item'],'snsSubscriptionConfirmed':confirmed,'logs':[{k:e[k] for k in ('timestamp','message')} for e in logs['events']],'emailReceipt':'Pendiente de comprobar por el destinatario'}
(root/'evidencia-api.json').write_text(json.dumps(evidence,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(evidence,indent=2,ensure_ascii=False))
