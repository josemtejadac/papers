// Acceso a arXiv con caché en D1, reintento y respaldo. No es una ruta: no exporta handlers.
//
// arXiv pide no más de una consulta cada ~3 segundos y responde 429 ("Rate exceeded") si se
// excede. Como todos los usuarios salen por servidores compartidos de Cloudflare, sin caché la
// app quedaría sin búsquedas justo cuando más se usa. Por eso:
//   1. Cada paper visto se guarda en D1 (arxiv_papers): pedir un paper conocido no consulta arXiv.
//   2. Cada búsqueda se guarda en D1 (arxiv_queries) por unas horas: repetirla no consulta arXiv.
//   3. Si arXiv falla o limita, se reintenta una vez y, si sigue fallando, se sirve lo guardado
//      aunque esté viejo (stale), en vez de dejar a la persona sin resultados.
// Si las tablas de caché todavía no existen (falta correr migration-005.sql) o D1 falla, todo
// sigue funcionando igual que antes: se consulta arXiv directo, sin caché.

import { parseArxivFeed } from './arxiv.js';

const USER_AGENT = 'Abstracta/1.0 (papers app; Cloudflare Pages)';
// arXiv publica papers nuevos una vez al día: una búsqueda guardada sirve por varias horas.
export const QUERY_FRESH_MS = 3 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Trae el XML de arXiv. Reintenta una vez si arXiv limita (429), está caído (5xx) o no responde.
export async function fetchArxivXml(url){
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        // Caché del propio borde de Cloudflare para respuestas buenas (nunca para errores).
        cf: { cacheTtlByStatus: { '200-299': 3600, '300-599': 0 } }
      });
      if (res.ok) return await res.text();
      lastError = new Error('arxiv status ' + res.status);
      if (res.status !== 429 && res.status < 500) break; // error "real" del pedido: no sirve reintentar
    } catch (e) {
      lastError = e;
    }
    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }
  throw lastError || new Error('arxiv failed');
}

export async function getCachedPapers(env, ids){
  const out = new Map();
  if (!env.DB || !ids.length) return out;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, data FROM arxiv_papers WHERE id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    results.forEach(r => { try { out.set(r.id, JSON.parse(r.data)); } catch (e) {} });
  } catch (e) { /* tabla aún no creada o D1 con problemas: sin caché */ }
  return out;
}

export function saveCachedPapers(env, entries, waitUntil){
  if (!env.DB || !entries.length) return;
  const now = new Date().toISOString();
  const job = env.DB.batch(entries.map(e => env.DB.prepare(
    `INSERT INTO arxiv_papers (id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`
  ).bind(e.id, JSON.stringify(e), now))).catch(() => {});
  if (waitUntil) waitUntil(job);
}

export async function getCachedQuery(env, key){
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT ids, fetched_at FROM arxiv_queries WHERE query_key = ?').bind(key).first();
    if (!row) return null;
    return { ids: JSON.parse(row.ids), fetchedAt: row.fetched_at };
  } catch (e) { return null; }
}

export function saveCachedQuery(env, key, ids, waitUntil){
  if (!env.DB) return;
  const job = env.DB.prepare(
    `INSERT INTO arxiv_queries (query_key, ids, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET ids = excluded.ids, fetched_at = excluded.fetched_at`
  ).bind(key, JSON.stringify(ids), new Date().toISOString()).run().catch(() => {});
  if (waitUntil) waitUntil(job);
}

export function isFresh(fetchedAt, maxAgeMs){
  const t = Date.parse(fetchedAt || '');
  return Number.isFinite(t) && (Date.now() - t) < maxAgeMs;
}

// Busca papers por id: primero en D1, y solo los que falten se piden a arXiv. Si arXiv falla,
// devuelve lo que haya guardado (puede ser una lista parcial) en vez de un error.
export async function lookupPapers(env, ids, waitUntil){
  const known = await getCachedPapers(env, ids);
  const missing = ids.filter(id => !known.has(id));
  let failed = false;
  if (missing.length) {
    const url = new URL('https://export.arxiv.org/api/query');
    url.searchParams.set('id_list', missing.join(','));
    url.searchParams.set('max_results', String(missing.length));
    try {
      const fetched = parseArxivFeed(await fetchArxivXml(url.toString()));
      fetched.forEach(e => known.set(e.id, e));
      saveCachedPapers(env, fetched, waitUntil);
    } catch (e) {
      failed = true;
    }
  }
  return { entries: ids.map(id => known.get(id)).filter(Boolean), failed };
}
