// Cliente de la API pública de arXiv (http://export.arxiv.org/api) + traducción opcional
// con Cloudflare Workers AI, cacheada en D1. No es una ruta: no exporta handlers.

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
const TRANSLATE_TIMEOUT_MS = 4000;
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
async function translateText(env, text, targetName){
  if(!text) return '';
  const input = text.length > MAX_TRANSLATE_CHARS ? text.slice(0, MAX_TRANSLATE_CHARS) : text;
  const res = await env.AI.run('@cf/meta/m2m100-1.2b', { text: input, source_lang: 'english', target_lang: targetName });
  const out = res && typeof res.translated_text === 'string' ? res.translated_text.trim() : '';
  // Respuesta vacía o claramente rota (mucho más corta que el original) = se trata como error,
  // para no mostrar un resumen cortado a la mitad como si fuera la traducción completa.
  if(!out || out.length < input.length * 0.25) throw new Error('translation looked broken');
  return out;
}

export async function translateEntries(env, entries, lang, waitUntil){
  if (!lang || lang === 'en' || !entries.length) {
    return entries.map(e => ({ ...e, titleEn: e.title, abstractEn: e.abstract }));
  }
  const targetName = LANG_NAMES[lang] || LANG_NAMES.es;
  const hasAI = !!(env.AI && typeof env.AI.run === 'function');
  const hasDB = !!env.DB;

  let cached = new Map();
  if (hasDB && entries.length) {
    const ids = entries.map(e => e.id);
    const { results } = await env.DB.prepare(
      `SELECT arxiv_id, title, abstract FROM paper_translations WHERE lang = ? AND arxiv_id IN (${ids.map(() => '?').join(',')})`
    ).bind(lang, ...ids).all();
    results.forEach(r => cached.set(r.arxiv_id, r));
  }

  async function translateOne(e){
    // Título y resumen se traducen por separado y de forma independiente: si uno falla o se
    // pasa del tiempo, igual se entrega el otro traducido en vez de perder los dos.
    const [titleR, abstractR] = await Promise.allSettled([
      withTimeout(translateText(env, e.title, targetName), TRANSLATE_TIMEOUT_MS),
      withTimeout(translateText(env, e.abstract, targetName), TRANSLATE_TIMEOUT_MS)
    ]);
    const title = titleR.status === 'fulfilled' ? titleR.value : e.title;
    const abstract = abstractR.status === 'fulfilled' ? abstractR.value : e.abstract;
    const fullyTranslated = titleR.status === 'fulfilled' && abstractR.status === 'fulfilled';
    if (hasDB && fullyTranslated) {
      await env.DB.prepare(
        `INSERT INTO paper_translations (arxiv_id, lang, title, abstract, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(arxiv_id, lang) DO UPDATE SET title = excluded.title, abstract = excluded.abstract`
      ).bind(e.id, lang, title, abstract, new Date().toISOString()).run().catch(() => {});
    }
    return { title, abstract, fullyTranslated };
  }

  return Promise.all(entries.map(async (e) => {
    const hit = cached.get(e.id);
    if (hit) return { ...e, title: hit.title, abstract: hit.abstract, titleEn: e.title, abstractEn: e.abstract };
    if (!hasAI) return { ...e, titleEn: e.title, abstractEn: e.abstract };
    try {
      const result = await translateOne(e);
      return { ...e, title: result.title, abstract: result.abstract, titleEn: e.title, abstractEn: e.abstract };
    } catch (err) {
      // No debería pasar (translateOne no tira errores propios), pero por si acaso: inglés y listo.
      return { ...e, titleEn: e.title, abstractEn: e.abstract };
    }
  }));
}
