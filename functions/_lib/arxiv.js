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

export async function translateEntries(env, entries, lang){
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

  return Promise.all(entries.map(async (e) => {
    const hit = cached.get(e.id);
    if (hit) return { ...e, title: hit.title, abstract: hit.abstract, titleEn: e.title, abstractEn: e.abstract };
    if (!hasAI) return { ...e, titleEn: e.title, abstractEn: e.abstract };
    try {
      const [tTitle, tAbs] = await Promise.all([
        env.AI.run('@cf/meta/m2m100-1.2b', { text: e.title, source_lang: 'english', target_lang: targetName }),
        env.AI.run('@cf/meta/m2m100-1.2b', { text: e.abstract, source_lang: 'english', target_lang: targetName })
      ]);
      const title = (tTitle && tTitle.translated_text) || e.title;
      const abstract = (tAbs && tAbs.translated_text) || e.abstract;
      if (hasDB) {
        env.DB.prepare(
          `INSERT INTO paper_translations (arxiv_id, lang, title, abstract, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(arxiv_id, lang) DO UPDATE SET title = excluded.title, abstract = excluded.abstract`
        ).bind(e.id, lang, title, abstract, new Date().toISOString()).run().catch(() => {});
      }
      return { ...e, title, abstract, titleEn: e.title, abstractEn: e.abstract };
    } catch (err) {
      return { ...e, titleEn: e.title, abstractEn: e.abstract };
    }
  }));
}
