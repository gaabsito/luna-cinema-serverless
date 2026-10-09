import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { createHandler } from './core.mjs';
const db = new DynamoDBClient({});
const sns = new SNSClient({});
const TableName = process.env.TABLE_NAME;
const encode = item => Object.fromEntries(Object.entries(item).map(([key,value]) => [key, typeof value === 'number' ? {N:String(value)} : typeof value === 'boolean' ? {BOOL:value} : {S:value}]));
const decode = item => Object.fromEntries(Object.entries(item).map(([key,value]) => [key, value.S ?? (value.N !== undefined ? Number(value.N) : value.BOOL)]));
const store = {
  async create(item) {
    try { await db.send(new PutItemCommand({TableName, Item:encode(item), ConditionExpression:'attribute_not_exists(id)'})); return {created:true,item}; }
    catch(error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const old = await db.send(new GetItemCommand({TableName, Key:{id:{S:item.id}}, ConsistentRead:true}));
      if (!old.Item) throw new Error('MissingRecord');
      return {created:false,item:decode(old.Item)};
    }
  },
  async claim(id) {
    const token = randomUUID(); const now = Math.floor(Date.now()/1000);
    try {
      await db.send(new UpdateItemCommand({TableName, Key:{id:{S:id}}, UpdateExpression:'SET notificationStatus = :processing, leaseUntil = :until, leaseToken = :token', ConditionExpression:'notificationStatus <> :sent AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)', ExpressionAttributeValues:{':processing':{S:'processing'}, ':sent':{S:'sent'}, ':until':{N:String(now+60)}, ':now':{N:String(now)}, ':token':{S:token}}}));
      return token;
    } catch(error) { if (error.name === 'ConditionalCheckFailedException') return null; throw error; }
  },
  async sent(id, token, messageId) {
    await db.send(new UpdateItemCommand({TableName,Key:{id:{S:id}},UpdateExpression:'SET notificationStatus = :sent, snsMessageId = :message REMOVE leaseUntil, leaseToken',ConditionExpression:'leaseToken = :token',ExpressionAttributeValues:{':sent':{S:'sent'},':message':{S:messageId},':token':{S:token}}}));
  },
  async release(id, token) {
    await db.send(new UpdateItemCommand({TableName,Key:{id:{S:id}},UpdateExpression:'SET notificationStatus = :pending REMOVE leaseUntil, leaseToken',ConditionExpression:'leaseToken = :token',ExpressionAttributeValues:{':pending':{S:'pending'},':token':{S:token}}}));
  }
};
export const handler = createHandler({store, publish: item => sns.send(new PublishCommand({TopicArn:process.env.TOPIC_ARN, Subject:'Luna Cinema · Nueva inscripción', Message:JSON.stringify({event:'signup_created', ...item},null,2)}))});
