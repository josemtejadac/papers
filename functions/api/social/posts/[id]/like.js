// POST /api/social/posts/:id/like  { deviceId }
// Alterna el "me gusta" de ese dispositivo sobre la publicación y devuelve el conteo actualizado.

import { json, safe, getUser, rateLimited, tooMany } from '../../../../_lib/util.js';

async function handlePost({ request, env, params }){
  const postId = params.id;
  const body = await request.json().catch(()=>null);
  // Solo personas con perfil pueden dar «me gusta» (evita inflar los contadores con ids inventados).
  const me = await getUser(env, body && body.deviceId);
  if(!me) return json({ error:'registro requerido' }, 401);
  const deviceId = me.device_id;
  if(await rateLimited(env, 'like-min:' + me.public_id, 60, 60)) return tooMany();

  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
  if(!post) return json({ error:'publicación no encontrada' }, 404);

  const existing = await env.DB.prepare(
    'SELECT 1 FROM post_likes WHERE post_id = ? AND device_id = ?'
  ).bind(postId, deviceId).first();

  let likedByMe;
  if(existing){
    await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ? AND device_id = ?').bind(postId, deviceId).run();
    await env.DB.prepare('UPDATE posts SET likes = MAX(likes - 1, 0) WHERE id = ?').bind(postId).run();
    likedByMe = false;
  } else {
    await env.DB.prepare('INSERT INTO post_likes (post_id, device_id) VALUES (?, ?)').bind(postId, deviceId).run();
    await env.DB.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').bind(postId).run();
    likedByMe = true;
  }

  const row = await env.DB.prepare('SELECT likes FROM posts WHERE id = ?').bind(postId).first();
  return json({ likes: row.likes, likedByMe });
}

export const onRequestPost = safe(handlePost);
