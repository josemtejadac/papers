// POST /api/auth/login {deviceId, email, password}
//
// Entra a una cuenta desde este teléfono. Funciona como WhatsApp: una cuenta queda activa en un
// solo teléfono a la vez; al entrar desde uno nuevo, la cuenta se "muda" a ese, y el anterior
// tendrá que volver a entrar para usarla. Devuelve el respaldo de la biblioteca y preferencias.

import { json, handleOf, safe } from '../../_lib/util.js';
import { verifyPassword, normalizeEmail } from '../../_lib/auth.js';

async function handlePost({ request, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : '';
  if(!deviceId) return json({ error: 'deviceId es requerido' }, 400);

  const email = normalizeEmail(body.email);
  const account = email ? await env.DB.prepare(
    'SELECT device_id, public_id, name, tag, affiliation, email, pass_hash, backup FROM users WHERE email = ?'
  ).bind(email).first() : null;
  // Mismo mensaje si el correo no existe o la contraseña está mal: no se revela cuál de las dos falló.
  if(!account || !(await verifyPassword(String(body.password || ''), account.pass_hash))){
    return json({ error: 'Correo o contraseña incorrectos.' }, 401);
  }

  if(account.device_id !== deviceId){
    const here = await env.DB.prepare('SELECT public_id, email FROM users WHERE device_id = ?').bind(deviceId).first();
    if(here && here.email){
      // En este teléfono estaba abierta OTRA cuenta: se la desconecta (sigue existiendo y se puede
      // volver a entrar a ella cuando quieran), no se borra.
      await env.DB.prepare('UPDATE users SET device_id = ? WHERE device_id = ?')
        .bind('detached_' + crypto.randomUUID(), deviceId).run();
    } else if(here){
      // Perfil anónimo (solo nombre) de este teléfono: se reemplaza por la cuenta.
      await env.DB.prepare('DELETE FROM users WHERE device_id = ?').bind(deviceId).run();
    }
    const oldDevice = account.device_id;
    await env.DB.prepare('UPDATE users SET device_id = ? WHERE public_id = ?').bind(deviceId, account.public_id).run();
    // Los "me gusta" y lo ya leído en chats estaban asociados al teléfono anterior: se traen.
    try{
      await env.DB.prepare('UPDATE OR IGNORE post_likes SET device_id = ? WHERE device_id = ?').bind(deviceId, oldDevice).run();
      await env.DB.prepare('UPDATE OR REPLACE conv_reads SET device_id = ? WHERE device_id = ?').bind(deviceId, oldDevice).run();
    } catch(e){ /* no es crítico: lo peor es ver algún mensaje como no leído */ }
  }

  let backup = null;
  try{ backup = account.backup ? JSON.parse(account.backup) : null; } catch(e){ backup = null; }
  return json({
    publicId: account.public_id, name: account.name, tag: account.tag,
    handle: handleOf(account), affiliation: account.affiliation || '', email: account.email, backup
  });
}

export const onRequestPost = safe(handlePost);
