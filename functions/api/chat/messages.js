// GET  /api/chat/messages?conv=<id>&device=<deviceId>&after=<seq>  -> mensajes nuevos de una conversación
// POST /api/chat/messages {deviceId, convId, text, paperId}          -> envía un mensaje (texto y/o paper)
//
// convId: "general" (sala pública, la ve todo el mundo) o "dm:<publicIdA>|<publicIdB>" (solo esas dos personas).

import { json, cleanText, getUser, dmMembers, handleOf } from '../../_lib/util.js';

function canAccess(convId, me){
  if(convId === 'general') return true;
  const members = dmMembers(convId);
  return !!(members && members.includes(me.public_id));
}

function mapRow(r){
  return { seq: r.seq, id: r.id, senderId: r.sender_id, senderName: r.sender_name, text: r.text, paperId: r.paper_id, createdAt: r.created_at };
}

export async function onRequestGet({ request, env }){
  const url = new URL(request.url);
  const convId = url.searchParams.get('conv') || '';
  const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
  const me = await getUser(env, url.searchParams.get('device'));
  if(!me) return json({ error: 'registro requerido' }, 401);
  if(!canAccess(convId, me)) return json({ error: 'sin acceso' }, 403);

  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT rowid AS seq, * FROM messages WHERE conv_id = ? AND rowid > ? ORDER BY rowid DESC LIMIT 100
     ) ORDER BY seq ASC`
  ).bind(convId, after).all();

  if(results.length && convId !== 'general'){
    const maxSeq = results[results.length - 1].seq;
    await env.DB.prepare(
      `INSERT INTO conv_reads (device_id, conv_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT(device_id, conv_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`
    ).bind(me.device_id, convId, maxSeq).run();
  }
  return json({ messages: results.map(mapRow) });
}

export async function onRequestPost({ request, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'registro requerido' }, 401);
  const convId = typeof body.convId === 'string' ? body.convId : '';
  if(!canAccess(convId, me)) return json({ error: 'sin acceso' }, 403);

  const text = cleanText(body.text, 1000);
  const paperId = body.paperId ? String(body.paperId).slice(0, 20) : null;
  if(!text && !paperId) return json({ error: 'mensaje vacío' }, 400);

  const id = 'm' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO messages (id, conv_id, sender_id, sender_name, text, paper_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, convId, me.public_id, handleOf(me), text || null, paperId, createdAt).run();

  const row = await env.DB.prepare('SELECT rowid AS seq, * FROM messages WHERE id = ?').bind(id).first();
  if(convId !== 'general'){
    await env.DB.prepare(
      `INSERT INTO conv_reads (device_id, conv_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT(device_id, conv_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`
    ).bind(me.device_id, convId, row.seq).run();
  }
  return json({ message: mapRow(row) }, 201);
}
