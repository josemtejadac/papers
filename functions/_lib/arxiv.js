// Cliente de la API pública de arXiv (http://export.arxiv.org/api) + traducción opcional
// con Cloudflare Workers AI, cacheada en D1. No es una ruta: no exporta handlers.

import { runChat } from './llm.js';

const ENTITIES = { lt:'<', gt:'>', quot:'"', apos:"'", amp:'&' };
function decodeXml(s){
  return String(s).replace(/&(lt|gt|quot|apos|amp);/g, (_, n) => ENTITIES[n])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}
function clean(s){ return decodeXml(s || '').replace(/\s+/g, ' ').trim(); }
function firstTag(block, name){
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>'));
  return m ? clean(m[1]) : '';
}
function allBlocks(xml, name){
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/' + name + '>', 'g');
  return xml.match(re) || [];
}
function allAttr(block, tagName, attrName){
  const re = new RegExp('<' + tagName + '\\b[^>]*\\b' + attrName + '="([^"]*)"[^>]*\\/?>', 'g');
  const out = []; let m;
  while ((m = re.exec(block))) out.push(decodeXml(m[1]));
  return out;
}
function oneAttr(block, tagName, attrName){ return allAttr(block, tagName, attrName)[0] || ''; }
// Tags completos (no solo un atributo), para cuando hace falta mirar varios atributos del mismo tag a la vez
// (p. ej. un <link> sin "title" no debe desalinear el que sí lo tiene).
function allTagStrings(block, name){
  const re = new RegExp('<' + name + '\\b[^>]*\\/?>', 'g');
  return block.match(re) || [];
}

// Etiquetas legibles para las categorías de arXiv más comunes; el resto se muestra tal cual (ej. "cs.DS").
const CATEGORY_LABELS = {
  'cs.AI':'Inteligencia artificial', 'cs.LG':'Aprendizaje automático', 'cs.CL':'Lingüística computacional',
  'cs.CV':'Visión por computador', 'cs.NE':'Redes neuronales', 'cs.RO':'Robótica', 'cs.CR':'Seguridad informática',
  'cs.DS':'Estructuras de datos', 'cs.DC':'Computación distribuida', 'cs.SE':'Ingeniería de software',
  'stat.ML':'Aprendizaje automático (estadística)', 'math.ST':'Estadística', 'math.OC':'Optimización',
  'q-bio.NC':'Neurociencia', 'q-bio.GN':'Genómica', 'q-bio.QM':'Métodos cuantitativos (biología)',
  'q-bio.CB':'Biología celular', 'q-bio.PE':'Biología de poblaciones', 'q-bio.TO':'Tejidos y órganos',
  'q-bio.BM':'Biomoléculas', 'physics.bio-ph':'Biofísica', 'physics.med-ph':'Física médica',
  'astro-ph':'Astrofísica', 'astro-ph.CO':'Cosmología', 'astro-ph.GA':'Astrofísica de galaxias',
  'astro-ph.EP':'Planetas y astrobiología', 'astro-ph.HE':'Astrofísica de altas energías',
  'astro-ph.SR':'Estrellas', 'astro-ph.IM':'Instrumentación astronómica',
  'cond-mat.mtrl-sci':'Ciencia de materiales', 'quant-ph':'Física cuántica', 'math.NA':'Análisis numérico'
};
export function categoryLabel(code){ return CATEGORY_LABELS[code] || code; }

export function parseArxivFeed(xml){
  return allBlocks(xml, 'entry').map(entry => {
    const rawId = firstTag(entry, 'id'); // http://arxiv.org/abs/2310.12345v2
    const idMatch = rawId.match(/abs\/([^v]+)/);
    const id = idMatch ? idMatch[1] : rawId;
    const authors = allBlocks(entry, 'author').map(a => firstTag(a, 'name')).filter(Boolean);
    const categories = allAttr(entry, 'category', 'term');
    const primary = oneAttr(entry, 'arxiv:primary_category', 'term') || categories[0] || '';
    const pdfTag = allTagStrings(entry, 'link').find(t => /title="pdf"/.test(t));
    const pdfHrefMatch = pdfTag && pdfTag.match(/href="([^"]*)"/);
    const pdfUrl = (pdfHrefMatch && decodeXml(pdfHrefMatch[1])) || 'https://arxiv.org/pdf/' + id;
    return {
      id,
      title: clean(firstTag(entry, 'title')),
      abstract: clean(firstTag(entry, 'summary')),
      authors: authors.join(', '),
      published: firstTag(entry, 'published').slice(0, 10),
      primaryCategory: primary,
      section: categoryLabel(primary),
      categories: categories.slice(0, 6),
      categoryLabels: categories.slice(0, 6).map(categoryLabel),
      doi: firstTag(entry, 'arxiv:doi') || null,
      pdfUrl: pdfUrl.replace(/^http:/, 'https:'),
      absUrl: 'https://arxiv.org/abs/' + id
    };
  });
}

// Nombres de idioma que espera el modelo de traducción de Workers AI (m2m100).
const LANG_NAMES = { es:'spanish', en:'english', pt:'portuguese', fr:'french' };

// Si una traducción no responde dentro de este tiempo, se muestra el original en inglés para
// esta visita (la traducción real sigue en segundo plano y queda cacheada para la próxima).
const TRANSLATE_TIMEOUT_MS = 9000;
// Ni el modelo ni el "resumen" de arXiv tienen límite de largo estricto, pero mandarle un texto
// demasiado largo al modelo de traducción es lo que más seguido causa una respuesta cortada o
// vacía ("errores de traducción"). Se recorta a un tamaño que el modelo traduce de forma confiable.
const MAX_TRANSLATE_CHARS = 1000;

function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

// Traduce un solo texto. Antes se pedían título+resumen juntos en una llamada, separados por una
// marca de texto — pero el modelo no siempre respeta esa marca al traducir, y eso mezclaba o
// perdía el resumen. Separado en una llamada por campo es más lento pero mucho más confiable.
// Traductor principal: un modelo de lenguaje (Gemma 4, ver _lib/llm.js). Traduce mucho mejor que
// m2m100 los términos técnicos (m2m100 llegó a poner "circuncisión" por "circumvention"), acepta el
// resumen completo y además cuesta menos. Si falla, se usa m2m100 como respaldo.
const MAX_LLM_TRANSLATE_CHARS = 3000;
function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
async function llmTranslate(env, text, targetName, sourceName){
  const input = text.length > MAX_LLM_TRANSLATE_CHARS ? text.slice(0, MAX_LLM_TRANSLATE_CHARS) : text;
  const target = cap(targetName), source = cap(sourceName || 'english');
  const { text: out } = await runChat(env, [
    { role: 'system', content:
      `You are a professional translator of scientific texts. Translate the user's text from ${source} to ${target}. ` +
      `Use the standard technical terms in ${target}. Keep acronyms, model and dataset names, formulas, LaTeX, numbers and proper names exactly as they are. ` +
      'Reply with ONLY the translation: no quotes, no notes, no explanations.' },
    { role: 'user', content: input }
  ], { maxTokens: Math.min(1500, Math.ceil(input.length / 2) + 60), timeoutMs: 20000 });
  const clean = String(out || '').trim().replace(/^["“«]|["”»]$/g, '').trim();
  if (!clean || clean.length < input.length * 0.4) throw new Error('translation looked broken');
  return clean;
}

async function translateText(env, text, targetName, sourceName){
  if(!text) return '';
  try { return await llmTranslate(env, text, targetName, sourceName); }
  catch (e) { return m2mTranslate(env, text, targetName, sourceName); }
}

async function m2mTranslate(env, text, targetName, sourceName){
  const input = text.length > MAX_TRANSLATE_CHARS ? text.slice(0, MAX_TRANSLATE_CHARS) : text;
  const res = await env.AI.run('@cf/meta/m2m100-1.2b', { text: input, source_lang: sourceName || 'english', target_lang: targetName });
  const out = res && typeof res.translated_text === 'string' ? res.translated_text.trim() : '';
  // Respuesta vacía o claramente rota (mucho más corta que el original) = se trata como error,
  // para no mostrar un resumen cortado a la mitad como si fuera la traducción completa.
  if(!out || out.length < input.length * 0.25) throw new Error('translation looked broken');
  return out;
}

// Títulos del tipo "Algo: subtítulo": el modelo suele traducir solo una de las dos partes y dejar
// la otra en inglés. Se traduce cada parte por separado y se vuelven a unir.
async function translateTitle(env, title, targetName){
  try { return await llmTranslate(env, title, targetName); } catch (e) { /* respaldo abajo */ }
  const m = String(title || '').match(/^(.{4,}?)\s*:\s*(.{4,})$/);
  if (!m) return m2mTranslate(env, title, targetName);
  const [a, b] = await Promise.all([m2mTranslate(env, m[1], targetName), m2mTranslate(env, m[2], targetName)]);
  return a + ': ' + b;
}

// Traduce un paper, campo por campo, reusando lo que ya esté en caché (cachedRow) y sin repetir
// una llamada a la IA por un campo que ya se tradujo antes. Si un campo se pasa del tiempo de
// espera, la llamada real sigue corriendo "de fondo": cuando termine (bien o mal), se guarda en
// D1 para la próxima persona, sin hacer esperar a quien hizo esta visita.
async function translateOne(env, e, cachedRow, targetName, lang, hasDB, waitUntil){
  const titleJob = (cachedRow && cachedRow.title) ? null : translateTitle(env, e.title, targetName).catch(() => null);
  const abstractJob = (cachedRow && cachedRow.abstract) ? null : translateText(env, e.abstract, targetName).catch(() => null);

  const [titleSettled, abstractSettled] = await Promise.allSettled([
    titleJob ? withTimeout(titleJob, TRANSLATE_TIMEOUT_MS) : Promise.resolve(cachedRow.title),
    abstractJob ? withTimeout(abstractJob, TRANSLATE_TIMEOUT_MS) : Promise.resolve(cachedRow.abstract)
  ]);
  const title = (titleSettled.status === 'fulfilled' && titleSettled.value) ? titleSettled.value : e.title;
  const abstract = (abstractSettled.status === 'fulfilled' && abstractSettled.value) ? abstractSettled.value : e.abstract;

  if (hasDB && (titleJob || abstractJob)) {
    const save = Promise.all([
      titleJob ? titleJob : Promise.resolve(null),
      abstractJob ? abstractJob : Promise.resolve(null)
    ]).then(([t, a]) => {
      if (!t && !a) return;
      return env.DB.prepare(
        `INSERT INTO paper_translations (arxiv_id, lang, title, abstract, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(arxiv_id, lang) DO UPDATE SET
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
           abstract = CASE WHEN excluded.abstract != '' THEN excluded.abstract ELSE abstract END,
           created_at = excluded.created_at`
      ).bind(e.id, lang, t || '', a || '', new Date().toISOString()).run();
    }).catch(() => {});
    if (waitUntil) waitUntil(save); else await save;
  }
  return { title, abstract };
}

// Traduce el texto de búsqueda al inglés antes de mandarlo a arXiv: su buscador es casi todo en
// inglés, así que buscar "familia" no encuentra nada aunque sí existan papers sobre el tema (ahí
// dice "family"). Si no hay IA disponible o la traducción falla/se demora, se busca tal cual.
const QUERY_TRANSLATE_TIMEOUT_MS = 4000;
export async function translateQueryToEnglish(env, text, lang){
  const q = (text || '').trim();
  if (!q || !lang || lang === 'en') return q;
  const hasAI = !!(env.AI && typeof env.AI.run === 'function');
  if (!hasAI) return q;
  const sourceName = LANG_NAMES[lang] || LANG_NAMES.es;
  try {
    const translated = await withTimeout(translateText(env, q, 'english', sourceName), QUERY_TRANSLATE_TIMEOUT_MS);
    // (sourceName indica de qué idioma viene la búsqueda; 'english' es a qué idioma se traduce)
    return translated || q;
  } catch (e) {
    return q;
  }
}

export async function translateEntries(env, entries, lang, waitUntil){
  if (!lang || lang === 'en' || !entries.length) {
    return entries.map(e => ({ ...e, titleEn: e.title, abstractEn: e.abstract }));
  }
  const targetName = LANG_NAMES[lang] || LANG_NAMES.es;
  const hasAI = !!(env.AI && typeof env.AI.run === 'function');
  const hasDB = !!env.DB;

  // Las traducciones del traductor nuevo se guardan como "es2" (etc.). Las antiguas ("es", de
  // m2m100) solo se usan para mostrar algo en español mientras la nueva se termina de generar.
  const cacheLang = lang + '2';
  let cached = new Map(), oldCached = new Map();
  if (hasDB && entries.length) {
    try {
      const ids = entries.map(e => e.id);
      const { results } = await env.DB.prepare(
        `SELECT arxiv_id, lang, title, abstract FROM paper_translations WHERE lang IN (?, ?) AND arxiv_id IN (${ids.map(() => '?').join(',')})`
      ).bind(cacheLang, lang, ...ids).all();
      results.forEach(r => (r.lang === cacheLang ? cached : oldCached).set(r.arxiv_id, r));
    } catch (e) {
      // Si la caché de D1 falla, no por eso se pierde la búsqueda: se sigue sin caché para esta vez.
    }
  }

  return Promise.all(entries.map(async (e) => {
    const hit = cached.get(e.id);
    const old = oldCached.get(e.id);
    if (!hasAI) {
      // Sin IA en este request, pero igual se sirve lo que ya hubiera quedado cacheado antes.
      return { ...e,
        title: (hit && hit.title) || (old && old.title) || e.title,
        abstract: (hit && hit.abstract) || (old && old.abstract) || e.abstract,
        titleEn: e.title, abstractEn: e.abstract };
    }
    const result = await translateOne(env, e, hit, targetName, cacheLang, hasDB, waitUntil);
    // Si la traducción nueva no alcanzó a llegar (quedó en inglés), se muestra la antigua si existe.
    const title = (result.title === e.title && old && old.title) ? old.title : result.title;
    const abstract = (result.abstract === e.abstract && old && old.abstract) ? old.abstract : result.abstract;
    return { ...e, title, abstract, titleEn: e.title, abstractEn: e.abstract };
  }));
}
