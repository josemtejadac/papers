// POST /api/papers/summary { id, lang, abstract }
//
// Genera un resumen corto en lenguaje simple de un paper, aparte de su resumen oficial, usando
// Workers AI. Se cachea en D1 para no repetir el trabajo con la misma persona u otra.

import { json, clean, safe, validArxivId, rateLimited, clientIp, tooMany } from '../../_lib/util.js';
import { runChat } from '../../_lib/llm.js';
import { lookupPapers } from '../../_lib/arxivFetch.js';

const LANG_NAMES = { es:'español', en:'inglés', pt:'portugués', fr:'francés' };
const SUMMARY_TIMEOUT_MS = 9000;

async function handlePost({ request, env, waitUntil }){
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'cuerpo inválido' }, 400);
  const id = clean(body.id, 40);
  const lang0 = (clean(body.lang, 5) || 'es').toLowerCase();
  const lang = LANG_NAMES[lang0] ? lang0 : 'es';
  if (!validArxivId(id)) return json({ error: 'id inválido' }, 400);

  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT summary FROM paper_summaries WHERE arxiv_id = ? AND lang = ?'
      ).bind(id, lang).first();
      if (row && row.summary) return json({ summary: row.summary, cached: true });
    } catch (e) { /* si falla la lectura de caché, igual intentamos generar el resumen */ }
  }
  if (!env.AI) return json({ summary: null });
  if (await rateLimited(env, 'summary-ip:' + clientIp(request), 60, 60)) return tooMany();

  // El resumen se genera SIEMPRE a partir del resumen oficial de arXiv que tiene el servidor, nunca
  // de un texto enviado por el teléfono: si no, alguien podría guardar un "resumen" falso que
  // después verían todos los que abren ese paper.
  const found = await lookupPapers(env, [id], waitUntil);
  const paper = found.entries[0];
  const abstract = paper && paper.abstract ? String(paper.abstract).slice(0, 2000) : '';
  if (!abstract) return json({ summary: null });

  const langName = LANG_NAMES[lang] || LANG_NAMES.es;
  try {
    const prompt = `Resume el siguiente resumen científico en máximo 2 frases simples y claras, en ${langName}, sin tecnicismos innecesarios. Responde solo con el resumen, sin introducciones:\n\n${abstract}`;
    const { text } = await runChat(env, [{ role: 'user', content: prompt }], { maxTokens: 180, timeoutMs: SUMMARY_TIMEOUT_MS });
    const summary = String(text || '').trim();
    if (!summary) return json({ summary: null });
    if (env.DB) {
      env.DB.prepare(
        `INSERT INTO paper_summaries (arxiv_id, lang, summary, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(arxiv_id, lang) DO UPDATE SET summary = excluded.summary`
      ).bind(id, lang, summary, new Date().toISOString()).run().catch(() => {});
    }
    return json({ summary });
  } catch (e) {
    return json({ summary: null });
  }
}

export const onRequestPost = safe(handlePost);
