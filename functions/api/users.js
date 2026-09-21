// GET  /api/users?q=texto      -> directorio público. q busca por nombre, afiliación o código ("Jose#48" / "#4821").
// POST /api/users {deviceId, name, affiliation} -> registra o actualiza el nombre; asigna un código único (Nombre#1234)

import { json, clean, handleOf } from '../_lib/util.js';

function likeEscape(s){ return s.replace(/[\\%_]/g, '\\$&'); }

function mapUser(r){
  return { publicId: r.public_id, name: r.name, tag: r.tag, handle: handleOf(r), affiliation: r.affiliation };
}

export async function onRequestGet({ request, env }){
  const raw = clean(new URL(request.url).searchParams.get('q'), 50).toLowerCase();
  let stmt;
  if(!raw){
    stmt = env.DB.prepare('SELECT public_id, name, tag, affiliation FROM users ORDER BY updated_at DESC LIMIT 50');
  } else if(raw.includes('#')){
    const i = raw.indexOf('#');
    const namePart = raw.slice(0, i).trim();
    const tagPart = raw.slice(i + 1).trim();
    const conds = []; const binds = [];
    if(namePart){ conds.push("lower(name) LIKE ? ESCAPE '\\'"); binds.push('%' + likeEscape(namePart) + '%'); }
    if(tagPart){ conds.push("tag LIKE ? ESCAPE '\\'"); binds.push(likeEscape(tagPart) + '%'); }
    if(!conds.length) conds.push('1=1');
    stmt = env.DB.prepare(
      `SELECT public_id, name, tag, affiliation FROM users WHERE ${conds.join(' AND ')} ORDER BY name COLLATE NOCASE ASC, tag ASC LIMIT 50`
    ).bind(...binds);
  } else {
    const like = '%' + likeEscape(raw) + '%';
    stmt = env.DB.prepare(
      `SELECT public_id, name, tag, affiliation FROM users
       WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(COALESCE(affiliation, '')) LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\'
       ORDER BY name COLLATE NOCASE ASC, tag ASC LIMIT 50`
    ).bind(like, like, likeEscape(raw) + '%');
  }
  const { results } = await stmt.all();
  return json({ users: results.map(mapUser) });
}

function randomTag(width){
  const min = Math.pow(10, width - 1), span = 9 * min;
  return String(min + Math.floor(Math.random() * span));
}

export async function onRequestPost({ request, env }){
  const body = await request.json().catch(() => null);
  const deviceId = body && clean(body.deviceId, 80);
  const name = body && clean(body.name, 40).replace(/#/g, '');
  const affiliation = body ? clean(body.affiliation, 80) : '';
  if(!deviceId || !name) return json({ error: 'deviceId y name son requeridos' }, 400);

  const existing = await env.DB.prepare('SELECT public_id, name, tag FROM users WHERE device_id = ?').bind(deviceId).first();
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
