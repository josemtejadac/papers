// Contraseñas: nunca se guardan tal cual, solo un "hash" PBKDF2-SHA256 con sal aleatoria.
// Formato guardado: pbkdf2$<iteraciones>$<sal en hex>$<hash en hex>
//
// 20.000 iteraciones: el plan gratis de Cloudflare corta una función que use más de 10 ms de CPU,
// y esto tarda ~2-3 ms. Guardar las iteraciones en el propio hash permite subirlas más adelante
// (por ejemplo con un plan pago) sin romper las contraseñas que ya existen.

const ITERATIONS = 20000;
const enc = new TextEncoder();

function toHex(bytes){
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex){
  const out = new Uint8Array(hex.length / 2);
  for(let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function derive(password, salt, iterations){
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPassword(password, stored){
  if(typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if(parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if(!(iterations > 0) || iterations > 100000) return false;
  const expected = fromHex(parts[3]);
  const actual = new Uint8Array(await derive(password, fromHex(parts[2]), iterations));
  if(actual.length !== expected.length) return false;
  let diff = 0;
  for(let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export function normalizeEmail(value){
  const email = String(value == null ? '' : value).trim().toLowerCase().slice(0, 120);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function validPassword(value){
  return typeof value === 'string' && value.length >= 6 && value.length <= 200;
}
