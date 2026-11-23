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
import * as smart from '../_lib/smartSearch.js';
const { interpretQuery, buildSmartQuery, rerankByMeaning, CANDIDATES } = smart;

const MAX_RESULTS = 15;

async function handleGet({ request, env, waitUntil }){
  const url = new URL(request.url);
  const lang = (clean(url.searchParams.get('lang'), 5) || 'es').toLowerCase();
  const max = Math.min(Math.max(parseInt(url.searchParams.get('max') || '8', 10) || 8, 1), MAX_RESULTS);
  const start = Math.max(parseInt(url.searchParams.get('start') || '0', 10) || 0, 0);

  let entries;
  let stale = false;
  let searchMode = 'cache'; // diagnóstico: cómo se resolvió la búsqueda (smart / simple: motivo / cache)

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
    const queryKey = JSON.stringify({ v: 4, q: qRaw.toLowerCase(), lang, categories, from, to, start, max });
    const cachedQuery = await getCachedQuery(env, queryKey);

    if (cachedQuery && isFresh(cachedQuery.fetchedAt, QUERY_FRESH_MS)) {
      const known = await getCachedPapers(env, cachedQuery.ids);
      const fromCache = cachedQuery.ids.map(id => known.get(id)).filter(Boolean);
      if (fromCache.length === cachedQuery.ids.length) entries = fromCache;
    }

    if (!entries) {
      try {
        const dateClause = (from || to)
          ? `submittedDate:[${(from || '1991-01-01').replace(/-/g, '')}0000 TO ${(to || '2100-01-01').replace(/-/g, '')}2359]`
          : '';
        const fetchList = async (searchQuery, sortBy, count, offset) => {
          const apiUrl = new URL('https://export.arxiv.org/api/query');
          apiUrl.searchParams.set('search_query', searchQuery);
          apiUrl.searchParams.set('sortBy', sortBy);
          apiUrl.searchParams.set('sortOrder', 'descending');
          apiUrl.searchParams.set('start', String(offset || 0));
          apiUrl.searchParams.set('max_results', String(count));
          return parseArxivFeed(await fetchArxivXml(apiUrl.toString()));
        };

        // Búsqueda que entiende el sentido (ver _lib/smartSearch.js). Si la IA no está o falla,
        // interp es null y se usa la búsqueda simple de abajo.
        const interp = (qRaw && start === 0) ? await interpretQuery(env, qRaw, lang) : null;
        searchMode = interp ? 'smart' : (qRaw ? 'simple: ' + (smart.lastInterpretIssue || 'skipped') : 'recent');
        if (interp) {
          let candidates = await fetchList(buildSmartQuery(interp, categories, dateClause), 'relevance', CANDIDATES);
          if (candidates.length < max && !categories.length && interp.categories.length) {
            // Pocas coincidencias en esas áreas: se amplía a todo arXiv; el orden por significado
            // deja al final lo que no tiene que ver.
            const more = await fetchList(buildSmartQuery({ ...interp, categories: [] }, [], dateClause), 'relevance', CANDIDATES).catch(() => []);
            const seen = new Set(candidates.map(e => e.id));
            candidates = candidates.concat(more.filter(e => !seen.has(e.id)));
          }
          entries = (await rerankByMeaning(env, candidates, interp.meaning)).slice(0, max);
        } else {
          // arXiv es casi todo en inglés: se traduce el término al inglés antes de mandarlo (si hay IA).
          const q = qRaw ? await translateQueryToEnglish(env, qRaw, lang) : '';
          const parts = [];
          if (categories.length) parts.push('(' + categories.map(c => 'cat:' + c).join(' OR ') + ')');
          const textQuery = buildTextQuery(q);
          if (textQuery) parts.push(textQuery);
          if (dateClause) parts.push(dateClause);
          if (!parts.length) parts.push('cat:cs.AI');
          // Con 2+ palabras: lo más relacionado primero. Con una sola, lo más nuevo (el orden por
          // relevancia de arXiv con una palabra trae cosas viejas y de otras áreas).
          const sortBy = textQuery && textQuery.includes(' AND ') ? 'relevance' : 'submittedDate';
          entries = await fetchList(parts.join(' AND '), sortBy, max, start);
        }
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
  return json({ papers: withLang, count: withLang.length, lang, stale, searchMode });
}

// Arma la parte de texto de la búsqueda para arXiv. Cada palabra importante debe aparecer en el
// título o en el resumen (no en cualquier parte, como autores o comentarios), y se descartan
// palabras vacías ("the", "of", "and"…) que solo meten ruido.
const STOPWORDS = new Set(['a','an','the','of','and','or','in','on','for','to','with','by','at','from','about','into','is','are','be','as','its','their','his','her','how','what','why','using','based']);
function buildTextQuery(q){
  const words = String(q || '').toLowerCase()
    .replace(/[^\p{L}\p{N}.\-\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w))
    .slice(0, 6);
  if (!words.length) return '';
  return '(' + words.map(w => `(ti:${w} OR abs:${w})`).join(' AND ') + ')';
}

export const onRequestGet = safe(handleGet);
