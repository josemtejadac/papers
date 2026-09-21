// POST /api/social/posts/:id/like  { deviceId }
// Alterna el "me gusta" de ese dispositivo sobre la publicación y devuelve el conteo actualizado.

function jsonResponse(data, status){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function onRequestPost({ request, env, params }){
  const postId = params.id;
  const body = await request.json().catch(()=>null);
  const deviceId = body && body.deviceId;
  if(!deviceId) return jsonResponse({ error:'deviceId es requerido' }, 400);

  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
  if(!post) return jsonResponse({ error:'publicación no encontrada' }, 404);

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
  return jsonResponse({ likes: row.likes, likedByMe });
}
