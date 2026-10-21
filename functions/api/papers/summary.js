// POST /api/papers/summary { id, lang, abstract }
//
// Genera un resumen corto en lenguaje simple de un paper, aparte de su resumen oficial, usando
// Workers AI. Se cachea en D1 para no repetir el trabajo con la misma persona u otra.

import { json, clean } from '../../_lib/util.js';

const LANG_NAMES = { es:'español', en:'inglés', pt:'portugués', fr:'francés' };
const SUMMARY_TIMEOUT_MS = 6000;

function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

export async function onRequestPost({ request, env }){
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'cuerpo inválido' }, 400);
  const id = clean(body.id, 40);
  const lang = (clean(body.lang, 5) || 'es').toLowerCase();
  const abstract = typeof body.abstract === 'string' ? body.abstract.slice(0, 2000) : '';
  if (!id || !abstract) return json({ error: 'id y abstract son requeridos' }, 400);

  if (env.DB) {
    const row = await env.DB.prepare(
      'SELECT summary FROM paper_summaries WHERE arxiv_id = ? AND lang = ?'
    ).bind(id, lang).first();
    if (row && row.summary) return json({ summary: row.summary, cached: true });
  }
  if (!env.AI) return json({ summary: null });

  const langName = LANG_NAMES[lang] || LANG_NAMES.es;
  try {
    const prompt = `Resume el siguiente resumen científico en máximo 2 frases simples y claras, en ${langName}, sin tecnicismos innecesarios. Responde solo con el resumen, sin introducciones:\n\n${abstract}`;
    const result = await withTimeout(
      env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 150 }),
      SUMMARY_TIMEOUT_MS
    );
    const summary = (result && typeof result.response === 'string') ? result.response.trim() : '';
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
