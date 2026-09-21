// POST /api/social/posts/:id/reply
// El prototipo no persiste el texto de las respuestas (solo el conteo), igual que la versión
// original en memoria: "no crea hilos de respuesta anidados, solo simula el conteo".

function jsonResponse(data, status){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export async function onRequestPost({ params, env }){
  const postId = params.id;
  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
  if(!post) return jsonResponse({ error:'publicación no encontrada' }, 404);

  await env.DB.prepare('UPDATE posts SET replies = replies + 1 WHERE id = ?').bind(postId).run();
  const row = await env.DB.prepare('SELECT replies FROM posts WHERE id = ?').bind(postId).first();
  return jsonResponse({ replies: row.replies });
}
