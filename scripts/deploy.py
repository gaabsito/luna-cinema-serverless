#!/usr/bin/env python3
"""Despliega sin copiar credenciales al proyecto. Requiere AWS CLI y LabRole."""
import argparse, json, os, subprocess, zipfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--region', default='us-west-2')
p.add_argument('--github-owner', required=True)
p.add_argument('--repo', default='luna-cinema-serverless')
p.add_argument('--notification-email', required=True)
a = p.parse_args()
def aws(service, operation, **kwargs):
    cmd = ['aws', service, operation, '--region', a.region, '--output', 'json', '--no-cli-pager']
    for k,v in kwargs.items():
        cmd.append('--'+k.replace('_','-'))
        if isinstance(v,bool):
            if not v: cmd[-1] = '--no-'+k.replace('_','-')
        elif isinstance(v,(dict,list)): cmd.append(json.dumps(v))
        else: cmd.append(str(v))
    result=subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}
def optional(service, action, missing, **kwargs):
    try: return aws(service,action,**kwargs)
    except RuntimeError as e:
        if missing not in str(e): raise
        return None
account=aws('sts','get-caller-identity')['Account']
role=aws('iam','get-role',role_name='LabRole')['Role']['Arn']
name='luna-cinema-gabriel'
bucket=f'{name}-{account}-{a.region}'
state={'region':a.region,'table':name,'bucket':bucket,'function':name}
print('Preparando tabla de inscripciones…',flush=True)
if not optional('dynamodb','describe-table','ResourceNotFoundException',table_name=name):
    aws('dynamodb','create-table',table_name=name,attribute_definitions=[{'AttributeName':'id','AttributeType':'S'}],key_schema=[{'AttributeName':'id','KeyType':'HASH'}],billing_mode='PAY_PER_REQUEST')
    subprocess.run(['aws','dynamodb','wait','table-exists','--table-name',name,'--region',a.region],check=True)
if aws('dynamodb','describe-time-to-live',table_name=name)['TimeToLiveDescription']['TimeToLiveStatus']=='DISABLED':
    aws('dynamodb','update-time-to-live',table_name=name,time_to_live_specification={'Enabled':True,'AttributeName':'expiresAt'})
topic=aws('sns','create-topic',name=name)['TopicArn']; state['topicArn']=topic
print('Preparando notificación SNS…',flush=True)
subscriptions=aws('sns','list-subscriptions-by-topic',topic_arn=topic)['Subscriptions']
if not any(s['Protocol']=='email' and s['Endpoint']==a.notification_email for s in subscriptions):
    aws('sns','subscribe',topic_arn=topic,protocol='email',notification_endpoint=a.notification_email)
print('Preparando hosting S3…',flush=True)
existing=aws('s3api','list-buckets')['Buckets']
if not any(b['Name']==bucket for b in existing):
    kwargs={'bucket':bucket}
    if a.region!='us-east-1': kwargs['create_bucket_configuration']={'LocationConstraint':a.region}
    aws('s3api','create-bucket',**kwargs)
aws('s3api','put-public-access-block',bucket=bucket,public_access_block_configuration={'BlockPublicAcls':True,'IgnorePublicAcls':True,'BlockPublicPolicy':False,'RestrictPublicBuckets':False})
# Lectura pública solo de los cinco archivos estáticos. No permite listar ni escribir.
files=['index.html','styles.css','app.js','config.js','cinema.svg']
policy={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':'*','Action':'s3:GetObject','Resource':[f'arn:aws:s3:::{bucket}/{f}' for f in files]}]}
aws('s3api','put-bucket-policy',bucket=bucket,policy=policy)
aws('s3api','put-bucket-website',bucket=bucket,website_configuration={'IndexDocument':{'Suffix':'index.html'}})
print('Preparando Lambda Node.js…',flush=True)
archive=ROOT/'scripts'/'lambda.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for f in ['index.mjs','core.mjs']: z.write(ROOT/'backend'/f,f)
variables={'Variables':{'TABLE_NAME':name,'TOPIC_ARN':topic}}
function=optional('lambda','get-function','ResourceNotFoundException',function_name=name)
if not function:
    function=aws('lambda','create-function',function_name=name,runtime='nodejs22.x',role=role,handler='index.handler',zip_file='fileb://'+str(archive),timeout=15,memory_size=128,environment=variables)
    arn=function['FunctionArn']
else:
    arn=function['Configuration']['FunctionArn']
    aws('lambda','update-function-code',function_name=name,zip_file='fileb://'+str(archive))
subprocess.run(['aws','lambda','wait','function-updated-v2','--function-name',name,'--region',a.region],check=True)
aws('lambda','update-function-configuration',function_name=name,environment=variables,timeout=15)
subprocess.run(['aws','lambda','wait','function-updated-v2','--function-name',name,'--region',a.region],check=True)
print('Preparando API Gateway…',flush=True)
s3url=f'http://{bucket}.s3-website-{a.region}.amazonaws.com'
cors={'AllowOrigins':[f'https://{a.github_owner}.github.io',s3url,'http://localhost:4173'],'AllowMethods':['POST','OPTIONS'],'AllowHeaders':['content-type'],'MaxAge':300}
apis=aws('apigatewayv2','get-apis')['Items']; api=next((x for x in apis if x['Name']==name),None)
if not api: api=aws('apigatewayv2','create-api',name=name,protocol_type='HTTP',cors_configuration=cors)
else: aws('apigatewayv2','update-api',api_id=api['ApiId'],cors_configuration=cors)
apiid=api['ApiId'];state['apiId']=apiid
integrations=aws('apigatewayv2','get-integrations',api_id=apiid)['Items']
integration=next((i for i in integrations if i.get('IntegrationUri')==arn),None)
if not integration: integration=aws('apigatewayv2','create-integration',api_id=apiid,integration_type='AWS_PROXY',integration_uri=arn,payload_format_version='2.0',timeout_in_millis=20000)
routes=aws('apigatewayv2','get-routes',api_id=apiid)['Items']
route=next((r for r in routes if r['RouteKey']=='POST /inscripciones'),None)
if not route: aws('apigatewayv2','create-route',api_id=apiid,route_key='POST /inscripciones',target='integrations/'+integration['IntegrationId'])
stages=aws('apigatewayv2','get-stages',api_id=apiid)['Items']
if not any(s['StageName']=='$default' for s in stages):
    aws('apigatewayv2','create-stage',api_id=apiid,stage_name='$default',auto_deploy=True,default_route_settings={'ThrottlingBurstLimit':5,'ThrottlingRateLimit':2})
try:
    aws('lambda','add-permission',function_name=name,statement_id='luna-api-invoke',action='lambda:InvokeFunction',principal='apigateway.amazonaws.com',source_arn=f'arn:aws:execute-api:{a.region}:{account}:{apiid}/*/POST/inscripciones')
except RuntimeError as e:
    if 'ResourceConflictException' not in str(e): raise
url=api['ApiEndpoint']+'/inscripciones'
(ROOT/'web'/'config.js').write_text('// Endpoint público: no contiene credenciales.\nwindow.CINEMA_CONFIG = '+json.dumps({'apiUrl':url})+';\n')
print('Publicando archivos de la web…',flush=True)
subprocess.run(['aws','s3','sync',str(ROOT/'web'),f's3://{bucket}','--region',a.region,'--cache-control','no-cache'],check=True)
state['apiUrl']=url;state['s3Url']=s3url
(ROOT/'scripts'/'state.json').write_text(json.dumps(state,indent=2))
links={'nombre':'Gabriel Galán García','grupo':'2SI','githubPages':f'https://{a.github_owner}.github.io/{a.repo}/','repositorio':f'https://github.com/{a.github_owner}/{a.repo}','apiGateway':url,'amazonS3':s3url}
(ROOT/'entrega.json').write_text(json.dumps(links,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(links,indent=2,ensure_ascii=False))
print('Confirma la suscripción SNS en tu correo antes de la comprobación final.')
