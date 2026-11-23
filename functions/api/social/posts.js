// GET  /api/social/posts?device=<deviceId>  -> lista de publicaciones (con likedByMe para ese device)
// POST /api/social/posts                    -> crea una publicación pública (texto y/o paper, o cita)
//
// Requiere un binding D1 llamado DB (Settings -> Bindings). Ver SETUP-SOCIAL-DB.md.

import { json, cleanText, getUser, handleOf, safe, validArxivId, rateLimited, tooMany } from '../../_lib/util.js';

function mapRow(row, likedIds, mePublicId){
  return {
    id: row.id,
    authorName: row.author_name,
    // Id público (el mismo de los chats): permite tocar el nombre y enviarle un mensaje privado.
    authorId: row.author_public_id || null,
    authorSub: row.author_sub,
    text: row.text,
    paperId: row.paper_id,
    quotedPostId: row.quoted_post_id,
    likes: row.likes,
    replies: row.replies,
    quotes: row.quotes,
    likedByMe: likedIds.has(row.id),
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    mine: !!(mePublicId && row.author_public_id === mePublicId)
  };
}

async function handleGet({ request, env }){
  const device = new URL(request.url).searchParams.get('device') || '';
  const me = device ? await getUser(env, device) : null;

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
  return json({ posts: results.map(r => mapRow(r, likedIds, me && me.public_id)) });
}

async function handlePost({ request, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'registro requerido' }, 401);

  const text = cleanText(body.text, 2000);
  const paperId = body.paperId ? String(body.paperId).slice(0, 30) : null;
  if(paperId && !validArxivId(paperId)) return json({ error: 'paper inválido' }, 400);
  const quotedPostId = body.quotedPostId ? String(body.quotedPostId).slice(0, 40) : null;
  if(!text && !paperId) return json({ error: 'publicación vacía' }, 400);
  if(quotedPostId && !(await env.DB.prepare('SELECT 1 FROM posts WHERE id = ?').bind(quotedPostId).first())) return json({ error: 'la publicación citada ya no existe' }, 404);
  // Anti spam: máximo 8 publicaciones por minuto y 60 por día por persona.
  if(await rateLimited(env, 'post-min:' + me.public_id, 8, 60) || await rateLimited(env, 'post-day:' + me.public_id, 60, 86400)) return tooMany('Estás publicando muy seguido. Espera un momento.');

  const id = 's' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO posts (id, author_name, author_sub, author_public_id, text, paper_id, quoted_post_id, likes, replies, quotes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`
  ).bind(id, handleOf(me), me.affiliation || '', me.public_id, text, paperId, quotedPostId, createdAt).run();

  if(quotedPostId){
    await env.DB.prepare('UPDATE posts SET quotes = quotes + 1 WHERE id = ?').bind(quotedPostId).run();
  }
  const row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  return json({ post: mapRow(row, new Set(), me.public_id) }, 201);
}

export const onRequestGet = safe(handleGet);
export const onRequestPost = safe(handlePost);
