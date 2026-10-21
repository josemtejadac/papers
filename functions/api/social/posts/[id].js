// PATCH  /api/social/posts/:id {deviceId, text}  -> edita el texto de tu propia publicación
// DELETE /api/social/posts/:id {deviceId}         -> elimina tu propia publicación

import { json, cleanText, getUser } from '../../../_lib/util.js';

export async function onRequestPatch({ request, params, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'registro requerido' }, 401);

  const post = await env.DB.prepare('SELECT author_public_id FROM posts WHERE id = ?').bind(params.id).first();
  if(!post) return json({ error: 'publicación no encontrada' }, 404);
  if(post.author_public_id !== me.public_id) return json({ error: 'solo puedes editar tus propias publicaciones' }, 403);

  const text = cleanText(body.text, 2000);
  if(!text) return json({ error: 'el texto no puede quedar vacío' }, 400);

  const editedAt = new Date().toISOString();
  await env.DB.prepare('UPDATE posts SET text = ?, edited_at = ? WHERE id = ?').bind(text, editedAt, params.id).run();
  return json({ text, editedAt });
}

export async function onRequestDelete({ request, params, env }){
  const body = await request.json().catch(() => ({}));
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'registro requerido' }, 401);

  const post = await env.DB.prepare('SELECT author_public_id FROM posts WHERE id = ?').bind(params.id).first();
  if(!post) return json({ error: 'publicación no encontrada' }, 404);
  if(post.author_public_id !== me.public_id) return json({ error: 'solo puedes eliminar tus propias publicaciones' }, 403);

  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM replies WHERE post_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ?').bind(params.id).run();
  return json({ deleted: true });
}
