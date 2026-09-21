// GET  /api/social/posts/:id/reply            -> respuestas de la publicación
// POST /api/social/posts/:id/reply {deviceId, text} -> agrega una respuesta

import { json, cleanText, getUser, handleOf } from '../../../../_lib/util.js';

export async function onRequestGet({ params, env }){
  const { results } = await env.DB.prepare(
    'SELECT id, author_name, author_sub, text, created_at FROM replies WHERE post_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200'
  ).bind(params.id).all();
  return json({ replies: results.map(r => ({ id: r.id, authorName: r.author_name, authorSub: r.author_sub, text: r.text, createdAt: r.created_at })) });
}

export async function onRequestPost({ request, params, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'registro requerido' }, 401);
  const text = cleanText(body.text, 1000);
  if(!text) return json({ error: 'respuesta vacía' }, 400);

  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(params.id).first();
  if(!post) return json({ error: 'publicación no encontrada' }, 404);

  const id = 'r' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  await env.DB.prepare(
    'INSERT INTO replies (id, post_id, author_name, author_sub, text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, params.id, handleOf(me), me.affiliation || '', text, new Date().toISOString()).run();
  await env.DB.prepare('UPDATE posts SET replies = replies + 1 WHERE id = ?').bind(params.id).run();

  const row = await env.DB.prepare('SELECT replies FROM posts WHERE id = ?').bind(params.id).first();
  return json({ replies: row.replies }, 201);
}
