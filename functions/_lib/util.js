// Utilidades compartidas por las Pages Functions (no es una ruta: no exporta handlers).

export function json(data, status){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

// Envuelve un handler de Pages Function para que, pase lo que pase adentro (D1 caído, un bug, lo
// que sea), SIEMPRE devuelva un JSON prolijo en vez de la página de error genérica de Cloudflare.
// El cliente (función api() de index.html) ya sabe mostrar un aviso cuando recibe un error así.
export function safe(handler){
  return async (ctx) => {
    try{
      return await handler(ctx);
    } catch(e){
      return json({ error: 'No se pudo completar la solicitud. Intenta de nuevo en un momento.' }, 500);
    }
  };
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
  const ok = id => /^p_[A-Za-z0-9]{6,40}$/.test(id);
  return ids.length === 2 && ok(ids[0]) && ok(ids[1]) && ids[0] !== ids[1] ? ids : null;
}

// ---------------------------------------------------------------------------------------------
// Seguridad

// deviceId válido: generado por la app (d_ + al menos 12 caracteres). Rechaza ids cortos o raros
// que serían fáciles de adivinar.
export function validDeviceId(value){
  return typeof value === 'string' && /^d_[A-Za-z0-9_-]{12,78}$/.test(value);
}

// Id de arXiv (nuevo "2401.01234" o antiguo "hep-th/9901001"), para los papers que se comparten.
export function validArxivId(value){
  return typeof value === 'string' && /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/.test(value);
}

// IP de quien hace la petición (Cloudflare la entrega en esta cabecera).
export function clientIp(request){
  return request.headers.get('CF-Connecting-IP') || 'desconocida';
}

// Límite de uso (anti spam y anti fuerza bruta): permite `limit` acciones por `windowSec` segundos
// para una misma clave (ej. "login-ip:1.2.3.4"). Se cuenta en D1. Si D1 falla, deja pasar: es
// preferible no bloquear a la gente por un problema de la base de datos.
let rateTableReady = false;
export async function rateLimited(env, key, limit, windowSec){
  if(!env.DB) return false;
  try{
    if(!rateTableReady){
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)').run();
      rateTableReady = true;
    }
    const now = Math.floor(Date.now() / 1000);
    const expired = now - windowSec;
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
       RETURNING count`
    ).bind(key, now, expired, expired).first();
    // De vez en cuando se limpian contadores viejos para que la tabla no crezca sin fin.
    if(Math.random() < 0.01){
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run().catch(() => {});
    }
    return !!(row && row.count > limit);
  } catch(e){
    return false;
  }
}

export function tooMany(message){
  return json({ error: message || 'Demasiados intentos seguidos. Espera un momento e intenta de nuevo.' }, 429);
}
