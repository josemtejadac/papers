// GET /api/papers?q=texto&category=cs.AI,q-bio.NC&ids=2310.12345,2401.00001&lang=es&start=0&max=10
//
// Busca papers reales en arXiv (http://export.arxiv.org/api) y, si hay un binding de Workers AI
// (env.AI), traduce título y resumen al idioma pedido (cacheado en D1 para no re-traducir).
//
// "Gracias a arXiv por el uso de su interoperabilidad de acceso abierto."
// Requerido por los términos de uso de la API de arXiv: https://info.arxiv.org/help/api/tou.html

import { json, clean } from '../_lib/util.js';
import { parseArxivFeed, translateEntries } from '../_lib/arxiv.js';

const MAX_RESULTS = 15;

export async function onRequestGet({ request, env, waitUntil }){
  const url = new URL(request.url);
  const lang = (clean(url.searchParams.get('lang'), 5) || 'es').toLowerCase();
  const max = Math.min(Math.max(parseInt(url.searchParams.get('max') || '8', 10) || 8, 1), MAX_RESULTS);
  const start = Math.max(parseInt(url.searchParams.get('start') || '0', 10) || 0, 0);

  const idsParam = clean(url.searchParams.get('ids'), 300);
  let searchQuery, idList;
  if (idsParam) {
    idList = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_RESULTS);
    if (!idList.length) return json({ papers: [] });
  } else {
    const q = clean(url.searchParams.get('q'), 200);
    const categories = clean(url.searchParams.get('category'), 200)
      .split(',').map(s => s.trim()).filter(Boolean);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '';
    const parts = [];
    if (categories.length) parts.push('(' + categories.map(c => 'cat:' + c).join(' OR ') + ')');
    if (q) parts.push('all:' + q.replace(/[()]/g, ' '));
    if (from || to) {
      const d0 = (from || '1991-01-01').replace(/-/g, '') + '0000';
      const d1 = (to || '2100-01-01').replace(/-/g, '') + '2359';
      parts.push(`submittedDate:[${d0} TO ${d1}]`);
    }
    if (!parts.length) parts.push('cat:cs.AI');
    searchQuery = parts.join(' AND ');
  }

  const apiUrl = new URL('https://export.arxiv.org/api/query');
  if (idList) {
    apiUrl.searchParams.set('id_list', idList.join(','));
  } else {
    apiUrl.searchParams.set('search_query', searchQuery);
    apiUrl.searchParams.set('sortBy', 'submittedDate');
    apiUrl.searchParams.set('sortOrder', 'descending');
  }
  apiUrl.searchParams.set('start', String(start));
  apiUrl.searchParams.set('max_results', String(max));

  let xml;
  try {
    const res = await fetch(apiUrl.toString(), { headers: { 'User-Agent': 'Abstracta/1.0 (papers app; Cloudflare Pages)' } });
    if (!res.ok) return json({ error: 'arXiv respondió con un error' }, 502);
    xml = await res.text();
  } catch (e) {
    return json({ error: 'no se pudo contactar a arXiv' }, 502);
  }

  let entries;
  try {
    entries = parseArxivFeed(xml);
  } catch (e) {
    return json({ error: 'no se pudo leer la respuesta de arXiv' }, 502);
  }

  const withLang = await translateEntries(env, entries, lang === 'en' ? 'en' : lang, waitUntil);
  return json({ papers: withLang, count: withLang.length, lang });
}
