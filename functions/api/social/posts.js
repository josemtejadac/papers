// GET  /api/social/posts?device=<deviceId>  -> lista de publicaciones (con likedByMe para ese device)
// POST /api/social/posts                    -> crea una publicación pública (texto y/o paper, o cita)
//
// Requiere un binding D1 llamado DB (Settings -> Bindings). Ver SETUP-SOCIAL-DB.md.

import { json, cleanText, getUser, handleOf } from '../../_lib/util.js';

function mapRow(row, likedIds){
  return {
    id: row.id,
    authorName: row.author_name,
    authorSub: row.author_sub,
    text: row.text,
    paperId: row.paper_id,
    quotedPostId: row.quoted_post_id,
    likes: row.likes,
    replies: row.replies,
    quotes: row.quotes,
    likedByMe: likedIds.has(row.id),
    createdAt: row.created_at
  };
}

export async function onRequestGet({ request, env }){
  const device = new URL(request.url).searchParams.get('device') || '';

  const { results } = await env.DB.prepare(
    'SELECT * FROM posts ORDER BY created_at DESC, rowid DESC LIMIT 100'
  ).all();

  let likedIds = new Set();
  if(device && results.length){
    const ids = results.map(r => r.id);
    const likedRes = await env.DB.prepare(
      `SELECT post_id FROM post_likes WHERE device_id = ? AND post_id IN (${ids.map(() => '?').join(',')})`
    ).bind(device, ...ids).all();
    likedIds = new Set(likedRes.results.map(r => r.post_id));
  }
  return json({ posts: results.map(r => mapRow(r, likedIds)) });
}

export async function onRequestPost({ request, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'registro requerido' }, 401);

  const text = cleanText(body.text, 2000);
  const paperId = body.paperId ? String(body.paperId).slice(0, 20) : null;
  const quotedPostId = body.quotedPostId ? String(body.quotedPostId).slice(0, 40) : null;
  if(!text && !paperId) return json({ error: 'publicación vacía' }, 400);

  const id = 's' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO posts (id, author_name, author_sub, text, paper_id, quoted_post_id, likes, replies, quotes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`
  ).bind(id, handleOf(me), me.affiliation || '', text, paperId, quotedPostId, createdAt).run();

  if(quotedPostId){
    await env.DB.prepare('UPDATE posts SET quotes = quotes + 1 WHERE id = ?').bind(quotedPostId).run();
  }
  const row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  return json({ post: mapRow(row, new Set()) }, 201);
}
