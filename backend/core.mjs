import { randomUUID } from 'node:crypto';
const interests = new Set(['clasicos', 'familia', 'descubrimientos', 'todos']);
const reply = (statusCode, data) => ({statusCode, headers:{'Content-Type':'application/json; charset=utf-8'}, body:JSON.stringify(data)});
export function createHandler({store, publish, log = console}) {
  return async (event, context = {}) => {
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    if (method !== 'POST') return reply(405, {message:'Método no permitido.'});
    let data;
    try {
      if (typeof event.body !== 'string' || event.body.length > 8192) return reply(400, {message:'Solicitud inválida.'});
      data = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch { return reply(400, {message:'El cuerpo debe contener JSON válido.'}); }
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (name.length < 2 || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return reply(400, {message:'El nombre debe tener entre 2 y 80 caracteres.'});
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, {message:'Escribe un email válido.'});
    if (!interests.has(data.interest)) return reply(400, {message:'Elige una sesión válida.'});
    if (data.consent !== true) return reply(400, {message:'Debes aceptar el uso de tus datos para inscribirte.'});
    if (typeof data.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId)) return reply(400, {message:'Identificador de solicitud inválido.'});
    const id = data.requestId;
    try {
      // Crear solo una vez: los reintentos del navegador conservan el identificador.
      const result = await store.create({id, name, email, interest:data.interest, consent:true, createdAt:new Date().toISOString(), notificationStatus:'pending', expiresAt:Math.floor(Date.now()/1000)+30*86400});
      const item = result.item;
      if (item.name !== name || item.email !== email || item.interest !== data.interest) return reply(409, {message:'Este identificador ya pertenece a otra solicitud.'});
      if (item.notificationStatus === 'sent') return reply(200, {id, notified:true, message:'Inscripción ya completada.'});
      const claim = await store.claim(id);
      if (!claim) return reply(503, {id, notified:false, message:'Tu inscripción se está procesando. Reintenta en unos segundos.'});
      try {
        const notification = await publish({id, name, email, interest:data.interest});
        await store.sent(id, claim, notification.MessageId);
        log.info(JSON.stringify({event:'signup_completed', id, awsRequestId:context.awsRequestId, snsMessageId:notification.MessageId}));
        return reply(result.created ? 201 : 200, {id, notified:true, message:'Inscripción guardada y notificación publicada.'});
      } catch (error) {
        await store.release(id, claim).catch(() => {});
        throw error;
      }
    } catch (error) {
      log.error(JSON.stringify({event:'signup_failed', id, awsRequestId:context.awsRequestId, error:error.name || 'Error'}));
      return reply(503, {id, notified:false, message:'No pudimos completar la inscripción. Vuelve a intentarlo.'});
    }
  };
}
