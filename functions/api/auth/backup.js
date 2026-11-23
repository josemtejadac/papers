// POST /api/auth/backup {deviceId, data}  -> guarda el respaldo de biblioteca y preferencias
// GET  /api/auth/backup?device=<deviceId> -> estado de la cuenta en este teléfono (para Perfil)
//
// Solo para perfiles con cuenta (correo + contraseña): es lo que se recupera al entrar desde
// otro teléfono. Los PDF descargados no viajan (viven en la memoria de cada teléfono).

import { json, safe } from '../../_lib/util.js';

const MAX_BACKUP_CHARS = 1000000;

async function handlePost({ request, env }){
  const body = await request.json().catch(() => null);
  if(!body || typeof body.deviceId !== 'string') return json({ error: 'cuerpo inválido' }, 400);
  const row = await env.DB.prepare('SELECT email FROM users WHERE device_id = ?').bind(body.deviceId).first();
  if(!row) return json({ error: 'registro requerido' }, 401);
  if(!row.email) return json({ error: 'Crea una cuenta para respaldar tus datos.' }, 403);

  if(!body.data || typeof body.data !== 'object') return json({ error: 'respaldo inválido' }, 400);
  const serialized = JSON.stringify(body.data);
  if(serialized.length > MAX_BACKUP_CHARS) return json({ error: 'Tu biblioteca es demasiado grande para respaldarla completa.' }, 413);

  const backupAt = new Date().toISOString();
  await env.DB.prepare('UPDATE users SET backup = ?, backup_at = ? WHERE device_id = ?')
    .bind(serialized, backupAt, body.deviceId).run();
  return json({ backupAt });
}

async function handleGet({ request, env }){
  const device = new URL(request.url).searchParams.get('device') || '';
  if(!device) return json({ error: 'registro requerido' }, 401);
  const row = await env.DB.prepare('SELECT email, backup_at FROM users WHERE device_id = ?').bind(device).first();
  if(!row) return json({ error: 'registro requerido' }, 401);
  return json({ email: row.email || null, backupAt: row.backup_at || null });
}

export const onRequestPost = safe(handlePost);
export const onRequestGet = safe(handleGet);
