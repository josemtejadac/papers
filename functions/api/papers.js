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
  lookupPapers, isFresh, QUERY_FRESH_MS, searchCachedPapers
} from '../_lib/arxivFetch.js';
import * as smart from '../_lib/smartSearch.js';
const { interpretQuery, buildSmartQuery, rerankByMeaning, CANDIDATES } = smart;

const MAX_RESULTS = 15;

async function handleGet({ request, env, waitUntil }){
  const url = new URL(request.url);
  // Solo idiomas conocidos (evita llenar la caché con claves inventadas).
  const lang0 = (clean(url.searchParams.get('lang'), 5) || 'es').toLowerCase();
  const lang = ['es', 'en', 'pt', 'fr'].includes(lang0) ? lang0 : 'es';
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

    // Si esta búsqueda ya se hizo antes, se responde AL INSTANTE con lo guardado. Si lo guardado
    // tiene más de unas horas, se actualiza desde arXiv "de fondo" para la próxima vez: así la app
    // nunca queda esperando a arXiv, que a veces tarda más de 10 segundos o limita las consultas.
    let fromCache = null;
    if (cachedQuery) {
      const known = await getCachedPapers(env, cachedQuery.ids);
      fromCache = cachedQuery.ids.map(id => known.get(id)).filter(Boolean);
      if (fromCache.length < Math.ceil(cachedQuery.ids.length / 2)) fromCache = null;
    }

    let interp = null;
    const dateClause = (from || to)
      ? `submittedDate:[${(from || '1991-01-01').replace(/-/g, '')}0000 TO ${(to || '2100-01-01').replace(/-/g, '')}2359]`
      : '';
    // Consulta arXiv de verdad y guarda el resultado. fast = alguien está esperando la respuesta.
    const runLiveSearch = async (fast) => {
      const fetchOpts = fast ? { attempts: 1, timeoutMs: 9000 } : { attempts: 2, timeoutMs: 12000 };
      const fetchList = async (searchQuery, sortBy, count, offset) => {
        const apiUrl = new URL('https://export.arxiv.org/api/query');
        apiUrl.searchParams.set('search_query', searchQuery);
        apiUrl.searchParams.set('sortBy', sortBy);
        apiUrl.searchParams.set('sortOrder', 'descending');
        apiUrl.searchParams.set('start', String(offset || 0));
        apiUrl.searchParams.set('max_results', String(count));
        return parseArxivFeed(await fetchArxivXml(apiUrl.toString(), fetchOpts));
      };
      let found;
      // Búsqueda que entiende el sentido (ver _lib/smartSearch.js). Si la IA no está o falla,
      // interp es null y se usa la búsqueda simple de abajo.
      interp = (qRaw && start === 0) ? await interpretQuery(env, qRaw, lang) : null;
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
        found = (await rerankByMeaning(env, candidates, interp.meaning)).slice(0, max);
        // Se guardan todos los candidatos (no solo los mostrados): así hay más papers disponibles
        // para buscar en lo guardado si arXiv deja de responder.
        saveCachedPapers(env, candidates, waitUntil);
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
        found = await fetchList(parts.join(' AND '), sortBy, max, start);
      }
      saveCachedPapers(env, found, waitUntil);
      if (found.length) saveCachedQuery(env, queryKey, found.map(e => e.id), waitUntil);
      return found;
    };

    if (fromCache) {
      entries = fromCache;
      if (!isFresh(cachedQuery.fetchedAt, QUERY_FRESH_MS)) {
        searchMode = 'cache, actualizando';
        const job = runLiveSearch(false).catch(() => {});
        if (waitUntil) waitUntil(job);
      }
    } else {
      try {
        entries = await runLiveSearch(true);
      } catch (e) {
        // Búsqueda nueva y arXiv caído o lento: se busca entre los papers que Abstracta ya guardó,
        // y se sigue intentando arXiv de fondo para que la próxima vez esté la búsqueda real.
        const job = runLiveSearch(false).catch(() => {});
        if (waitUntil) waitUntil(job);
        const terms = interp ? interp.keywords.concat(interp.english.split(' '))
          : qRaw ? qRaw.split(/\s+/)
          : categories.length ? categories : [];
        let local = await searchCachedPapers(env, terms, 60);
        if (local.length && interp) local = await rerankByMeaning(env, local, interp.meaning);
        if (local.length) { entries = local.slice(0, max); stale = true; searchMode += ' | local'; }
        if (!entries) return json({ error: 'arXiv está saturado en este momento y todavía no hay papers guardados sobre este tema. Intenta de nuevo en un rato.' }, 502);
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
