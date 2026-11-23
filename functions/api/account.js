// DELETE /api/account {deviceId}
//
// "Eliminar mi cuenta y mis datos" (derecho de supresión, Ley 21.719). Borra de la base de datos
// todo lo que identifica a la persona: su perfil (nombre, código, correo, contraseña cifrada y
// respaldo), sus publicaciones con las respuestas que recibieron, sus respuestas en publicaciones
// de otros, sus "me gusta", sus mensajes y su registro de lectura de chats. No se puede deshacer.
//
// Lo que queda guardado en el propio teléfono (biblioteca, PDFs) lo borra la app en ese momento.
// Las traducciones y resúmenes de papers no son datos personales: se comparten entre todos.

import { json, getUser, handleOf, safe } from '../_lib/util.js';

async function handleDelete({ request, env }){
  const body = await request.json().catch(() => null);
  if (!body || typeof body.deviceId !== 'string') return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if (!me) return json({ error: 'No encontramos una cuenta en este teléfono.' }, 404);

  const handle = handleOf(me);
  const deviceId = me.device_id;
  const pid = me.public_id;

  // Antes de borrar los "me gusta" y respuestas de la persona, se descuentan de los contadores de
  // las publicaciones ajenas, para que los números sigan cuadrando.
  const statements = [
    env.DB.prepare(`UPDATE posts SET likes = MAX(0, likes - 1)
      WHERE id IN (SELECT post_id FROM post_likes WHERE device_id = ?)`).bind(deviceId),
    env.DB.prepare(`UPDATE posts SET replies = MAX(0, replies -
      (SELECT COUNT(*) FROM replies r WHERE r.post_id = posts.id AND r.author_name = ?))
      WHERE id IN (SELECT post_id FROM replies WHERE author_name = ?)`).bind(handle, handle),
    env.DB.prepare('DELETE FROM post_likes WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM replies WHERE author_name = ?').bind(handle),
    // Publicaciones propias, con sus respuestas y "me gusta".
    env.DB.prepare('DELETE FROM replies WHERE post_id IN (SELECT id FROM posts WHERE author_public_id = ?)').bind(pid),
    env.DB.prepare('DELETE FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE author_public_id = ?)').bind(pid),
    env.DB.prepare('DELETE FROM posts WHERE author_public_id = ?').bind(pid),
    env.DB.prepare('DELETE FROM messages WHERE sender_id = ?').bind(pid),
    env.DB.prepare('DELETE FROM conv_reads WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM users WHERE device_id = ?').bind(deviceId)
  ];
  // Todo o nada: si algo falla a la mitad, no queda la cuenta borrada a medias.
  await env.DB.batch(statements);
  return json({ deleted: true });
}

export const onRequestDelete = safe(handleDelete);
