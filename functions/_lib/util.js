// Utilidades compartidas por las Pages Functions (no es una ruta: no exporta handlers).

export function json(data, status){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export function clean(value, max){
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Texto libre (mensajes, posts): conserva saltos de línea, limita el largo.
export function cleanText(value, max){
  return String(value == null ? '' : value).replace(/\r/g, '').trim().slice(0, max);
}

// Nombre visible con código único, estilo "Jose#4821". Así dos personas con el mismo nombre no se confunden.
export function handleOf(u){
  return u && u.tag ? u.name + '#' + u.tag : (u ? u.name : '');
}

// El deviceId es un secreto del navegador (no se lista públicamente). Identifica al usuario registrado.
export async function getUser(env, deviceId){
  if(!deviceId) return null;
  return await env.DB.prepare(
    'SELECT device_id, public_id, name, tag, affiliation FROM users WHERE device_id = ?'
  ).bind(deviceId).first();
}

// Fragmento SQL para saber si un usuario (public_id) participa de una conversación directa.
// conv_id tiene la forma dm:<idA>|<idB>
export const DM_MEMBER_SQL = "instr('|' || substr(conv_id, 4) || '|', ?) > 0";
export function memberParam(publicId){ return '|' + publicId + '|'; }

export function dmMembers(convId){
  if(typeof convId !== 'string' || !convId.startsWith('dm:')) return null;
  const ids = convId.slice(3).split('|');
  return ids.length === 2 && ids[0] && ids[1] ? ids : null;
}
