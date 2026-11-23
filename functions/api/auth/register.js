// POST /api/auth/register {deviceId, email, password}
//
// "Crear cuenta" = proteger el perfil que ya tienes en este teléfono (nombre, código, chats,
// publicaciones) con un correo y una contraseña, para poder entrar desde otro teléfono.
// No se envía ningún correo de confirmación: el correo solo sirve como usuario para entrar.

import { json, getUser, safe } from '../../_lib/util.js';
import { hashPassword, normalizeEmail, validPassword } from '../../_lib/auth.js';

async function handlePost({ request, env }){
  const body = await request.json().catch(() => null);
  if(!body) return json({ error: 'cuerpo inválido' }, 400);
  const me = await getUser(env, body.deviceId);
  if(!me) return json({ error: 'Primero elige tu nombre en la app.' }, 401);

  const email = normalizeEmail(body.email);
  if(!email) return json({ error: 'Ese correo no parece válido.' }, 400);
  if(!validPassword(body.password)) return json({ error: 'La contraseña debe tener al menos 6 caracteres.' }, 400);

  const mine = await env.DB.prepare('SELECT email FROM users WHERE device_id = ?').bind(me.device_id).first();
  if(mine && mine.email) return json({ error: 'Este perfil ya tiene una cuenta creada.' }, 409);

  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if(taken) return json({ error: 'Ese correo ya tiene una cuenta. Usa «Entrar».' }, 409);

  const passHash = await hashPassword(body.password);
  try{
    await env.DB.prepare('UPDATE users SET email = ?, pass_hash = ? WHERE device_id = ?')
      .bind(email, passHash, me.device_id).run();
  } catch(e){
    // Dos personas registrando el mismo correo al mismo tiempo: el índice único lo frena.
    return json({ error: 'Ese correo ya tiene una cuenta. Usa «Entrar».' }, 409);
  }
  return json({ email });
}

export const onRequestPost = safe(handlePost);
