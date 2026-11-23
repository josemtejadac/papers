// GET /api/papers?q=texto&category=cs.AI,q-bio.NC&from=2024-01-01&to=2024-12-31&lang=es&start=0&max=8
// GET /api/papers?ids=2310.12345,2401.00001&lang=es
//
// Busca papers reales en arXiv (https://export.arxiv.org/api) y, si hay un binding de Workers AI
// (env.AI), traduce título y resumen al idioma pedido (cacheado en D1 para no re-traducir).
// Las respuestas de arXiv también se guardan en D1 (ver _lib/arxivFetch.js): si arXiv falla o
// limita las consultas, se sirven los resultados guardados en vez de un error.
//
// "Gracias a arXiv por el uso de su interoperabilidad de acceso abierto."
// Requerido por los términos de uso de la API de arXiv: https://info.arxiv.org/help/api/tou.html

import { json, clean, safe } from '../_lib/util.js';
import { parseArxivFeed, translateEntries, translateQueryToEnglish } from '../_lib/arxiv.js';
import {
  fetchArxivXml, getCachedPapers, saveCachedPapers, getCachedQuery, saveCachedQuery,
  lookupPapers, isFresh, QUERY_FRESH_MS
} from '../_lib/arxivFetch.js';

const MAX_RESULTS = 15;

async function handleGet({ request, env, waitUntil }){
  const url = new URL(request.url);
  const lang = (clean(url.searchParams.get('lang'), 5) || 'es').toLowerCase();
  const max = Math.min(Math.max(parseInt(url.searchParams.get('max') || '8', 10) || 8, 1), MAX_RESULTS);
  const start = Math.max(parseInt(url.searchParams.get('start') || '0', 10) || 0, 0);

  let entries;
  let stale = false;

  const idsParam = clean(url.searchParams.get('ids'), 300);
  if (idsParam) {
    const idList = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_RESULTS);
    if (!idList.length) return json({ papers: [] });
    const result = await lookupPapers(env, idList, waitUntil);
    if (!result.entries.length && result.failed) return json({ error: 'no se pudo contactar a arXiv' }, 502);
    entries = result.entries;
    stale = result.failed;
  } else {
    const qRaw = clean(url.searchParams.get('q'), 200);
    const categories = clean(url.searchParams.get('category'), 200)
      .split(',').map(s => s.trim()).filter(Boolean).sort();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '';

    // La clave usa la búsqueda tal como la escribió la persona: si ya se buscó antes, ni siquiera
    // hace falta volver a traducir el término ni consultar arXiv.
    const queryKey = JSON.stringify({ q: qRaw.toLowerCase(), lang, categories, from, to, start, max });
    const cachedQuery = await getCachedQuery(env, queryKey);

    if (cachedQuery && isFresh(cachedQuery.fetchedAt, QUERY_FRESH_MS)) {
      const known = await getCachedPapers(env, cachedQuery.ids);
      const fromCache = cachedQuery.ids.map(id => known.get(id)).filter(Boolean);
      if (fromCache.length === cachedQuery.ids.length) entries = fromCache;
    }

    if (!entries) {
      try {
        // arXiv es casi todo en inglés: una búsqueda en español no encuentra nada aunque el tema
        // sí esté cubierto. Se traduce el término al inglés antes de mandarlo (si hay IA).
        const q = qRaw ? await translateQueryToEnglish(env, qRaw, lang) : '';
        const parts = [];
        if (categories.length) parts.push('(' + categories.map(c => 'cat:' + c).join(' OR ') + ')');
        if (q) parts.push('all:' + q.replace(/[()"]/g, ' '));
        if (from || to) {
          const d0 = (from || '1991-01-01').replace(/-/g, '') + '0000';
          const d1 = (to || '2100-01-01').replace(/-/g, '') + '2359';
          parts.push(`submittedDate:[${d0} TO ${d1}]`);
        }
        if (!parts.length) parts.push('cat:cs.AI');

        const apiUrl = new URL('https://export.arxiv.org/api/query');
        apiUrl.searchParams.set('search_query', parts.join(' AND '));
        apiUrl.searchParams.set('sortBy', 'submittedDate');
        apiUrl.searchParams.set('sortOrder', 'descending');
        apiUrl.searchParams.set('start', String(start));
        apiUrl.searchParams.set('max_results', String(max));

        entries = parseArxivFeed(await fetchArxivXml(apiUrl.toString()));
        saveCachedPapers(env, entries, waitUntil);
        saveCachedQuery(env, queryKey, entries.map(e => e.id), waitUntil);
      } catch (e) {
        // arXiv no respondió (o limitó): si esta búsqueda ya se había hecho antes, se muestra lo
        // guardado aunque sea de hace más tiempo, en vez de dejar a la persona sin nada.
        if (cachedQuery) {
          const known = await getCachedPapers(env, cachedQuery.ids);
          const fromCache = cachedQuery.ids.map(id => known.get(id)).filter(Boolean);
          if (fromCache.length) { entries = fromCache; stale = true; }
        }
        if (!entries) return json({ error: 'arXiv no está respondiendo en este momento. Intenta de nuevo en un rato.' }, 502);
      }
    }
  }

  const withLang = await translateEntries(env, entries, lang === 'en' ? 'en' : lang, waitUntil);
  return json({ papers: withLang, count: withLang.length, lang, stale });
}

export const onRequestGet = safe(handleGet);
