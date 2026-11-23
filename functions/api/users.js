// GET  /api/users?q=Nombre#1234 -> busca UNA persona por su código exacto (privacidad: no hay lista
//                                 pública de usuarios; para escribirle a alguien hay que conocer su
//                                 código, o tocar su nombre en la comunidad).
// POST /api/users {deviceId, name, affiliation} -> registra o actualiza el nombre; asigna un código único (Nombre#1234)

import { json, clean, validDeviceId, rateLimited, clientIp, tooMany, handleOf, safe } from '../_lib/util.js';

function mapUser(r){
  return { publicId: r.public_id, name: r.name, tag: r.tag, handle: handleOf(r), affiliation: r.affiliation };
}

async function handleGet({ request, env }){
  const raw = clean(new URL(request.url).searchParams.get('q'), 60);
  const m = raw.match(/^(.+?)\s*#\s*(\d{4,6})$/);
  // Sin código completo no se devuelve a nadie: así no se puede recorrer el directorio.
  if(!m) return json({ users: [] });
  // Límite de búsquedas por conexión, para que no se puedan probar códigos al azar.
  if(await rateLimited(env, 'usersearch-ip:' + clientIp(request), 60, 60)) return json({ error: 'Demasiadas búsquedas seguidas. Espera un momento.' }, 429);
  const row = await env.DB.prepare(
    'SELECT public_id, name, tag, affiliation FROM users WHERE lower(name) = lower(?) AND tag = ? LIMIT 1'
  ).bind(m[1].trim(), m[2]).first();
  return json({ users: row ? [mapUser(row)] : [] });
}

function randomTag(width){
  const min = Math.pow(10, width - 1), span = 9 * min;
  return String(min + Math.floor(Math.random() * span));
}

async function handlePost({ request, env }){
  const body = await request.json().catch(() => null);
  const deviceId = body && clean(body.deviceId, 80);
  const name = body && clean(body.name, 40).replace(/#/g, '');
  const affiliation = body ? clean(body.affiliation, 80) : '';
  if(!deviceId || !name) return json({ error: 'deviceId y name son requeridos' }, 400);

  const existing = await env.DB.prepare('SELECT public_id, name, tag FROM users WHERE device_id = ?').bind(deviceId).first();
  if(!existing){
    // Perfil nuevo: id con formato válido y un tope de perfiles nuevos por conexión (anti bots).
    if(!validDeviceId(deviceId)) return json({ error: 'identificador inválido' }, 400);
    if(await rateLimited(env, 'newuser-ip:' + clientIp(request), 60, 3600)) return tooMany('Se crearon demasiados perfiles desde esta conexión. Intenta más tarde.');
  }
  const publicId = existing ? existing.public_id : 'p_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  // Si el nombre no cambió, conserva el mismo código; si cambió, se asigna uno nuevo libre para ese nombre.
  let tag = existing && existing.name.toLowerCase() === name.toLowerCase() ? existing.tag : null;

  for(let attempt = 0; attempt < 40; attempt++){
    if(!tag){
      const candidate = randomTag(attempt < 25 ? 4 : 6);
      const taken = await env.DB.prepare(
        'SELECT 1 FROM users WHERE lower(name) = lower(?) AND tag = ? AND device_id != ?'
      ).bind(name, candidate, deviceId).first();
      if(taken) continue;
      tag = candidate;
    }
    try{
      await env.DB.prepare(
        `INSERT INTO users (device_id, public_id, name, tag, affiliation, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, tag = excluded.tag, affiliation = excluded.affiliation, updated_at = excluded.updated_at`
      ).bind(deviceId, publicId, name, tag, affiliation, new Date().toISOString()).run();
      return json({ publicId, name, tag, handle: name + '#' + tag, affiliation });
    } catch(e){
      tag = null; // colisión de código en el índice único: reintenta con otro
    }
  }
  return json({ error: 'no se pudo asignar un código, intenta con otro nombre' }, 500);
}

export const onRequestGet = safe(handleGet);
export const onRequestPost = safe(handlePost);
