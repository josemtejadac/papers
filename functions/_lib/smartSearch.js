// Búsqueda "inteligente" sobre arXiv.
//
// arXiv busca palabras tal cual, sin entender el sentido: "familia" -> "family" trae sobre todo
// matemáticas ("una familia de funciones"), porque ahí la palabra aparece muchísimo. Para que la
// búsqueda entienda lo que la persona quiere decir:
//   1. Un modelo de lenguaje (Workers AI) interpreta la búsqueda en su sentido cotidiano y la
//      convierte en términos en inglés + las categorías de arXiv donde viven esos papers.
//   2. Se busca en arXiv con esos términos dentro de esas categorías (varios candidatos).
//   3. Un modelo de "embeddings" ordena los candidatos según qué tan parecido es cada uno a lo que
//      la persona busca, y se quedan los mejores. Lo que no tiene que ver queda fuera.
// Si la IA no está disponible o falla, se vuelve a la búsqueda simple de siempre.

const LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const INTERPRET_TIMEOUT_MS = 7000;
const EMBED_TIMEOUT_MS = 6000;
export const CANDIDATES = 25;

const LANG_NAMES = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' };
const CATEGORY_RE = /^(cs|math|physics|astro-ph|cond-mat|gr-qc|hep-ex|hep-lat|hep-ph|hep-th|math-ph|nlin|nucl-ex|nucl-th|quant-ph|q-bio|q-fin|stat|econ|eess)(\.[A-Za-z]{2,3})?$/;

function withTimeout(promise, ms){
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function cleanTerm(t){
  return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Último motivo por el que no se pudo interpretar (para diagnóstico en la respuesta de la API).
export let lastInterpretIssue = '';

function parseJsonLoose(text){
  if (text && typeof text === 'object') return text; // algunas versiones ya entregan el JSON armado
  const s = String(text || '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// Paso 1: interpretar la búsqueda. Devuelve { english, keywords[], categories[], meaning } o null.
export async function interpretQuery(env, text, lang){
  lastInterpretIssue = '';
  if (!env.AI || typeof env.AI.run !== 'function'){ lastInterpretIssue = 'no-ai'; return null; }
  const q = String(text || '').trim().slice(0, 200);
  if (!q) return null;
  const langName = LANG_NAMES[lang] || 'Spanish';
  const system =
    'You turn a person\'s search for scientific papers into a search on arXiv. ' +
    `The person usually writes in ${langName}. Understand the words in their everyday meaning for a general reader ` +
    '(for example "familia" means family as a social group: households, parents, children, family relationships; ' +
    'NOT a mathematical "family of functions"), unless the search is clearly a technical term ' +
    '(like "transformers", "redes neuronales", "agujeros negros"). ' +
    'Reply with ONLY a JSON object, no other text: ' +
    '{"english": "the search translated to English", ' +
    '"keywords": ["2 to 5 short English words or 2-word phrases that relevant paper titles or abstracts would contain"], ' +
    '"categories": ["2 to 6 arXiv category codes where those papers are published, e.g. econ.GN, physics.soc-ph, cs.CY, q-bio.NC, cs.LG, stat.AP"], ' +
    '"meaning": "one English sentence describing exactly what the person is looking for"}';
  try {
    const res = await withTimeout(env.AI.run(LLM_MODEL, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: q }],
      max_tokens: 220, temperature: 0.1
    }), INTERPRET_TIMEOUT_MS);
    const data = parseJsonLoose(res && res.response);
    if (!data){ lastInterpretIssue = 'bad-json: ' + String(res && (typeof res.response === 'string' ? res.response : JSON.stringify(res))).slice(0, 160); return null; }
    const keywords = Array.from(new Set((Array.isArray(data.keywords) ? data.keywords : [])
      .map(cleanTerm).filter(k => k && k.split(' ').length <= 3))).slice(0, 5);
    const categories = Array.from(new Set((Array.isArray(data.categories) ? data.categories : [])
      .map(c => String(c || '').trim()).filter(c => CATEGORY_RE.test(c)))).slice(0, 6);
    const english = cleanTerm(data.english) || keywords[0] || '';
    const meaning = String(data.meaning || '').slice(0, 300).trim() || english;
    if (!keywords.length && !english){ lastInterpretIssue = 'empty'; return null; }
    if (!keywords.length) keywords.push(english);
    return { english, keywords, categories, meaning };
  } catch (e) {
    lastInterpretIssue = 'error: ' + String(e && e.message || e).slice(0, 160);
    return null;
  }
}

// Paso 2: arma la consulta de arXiv con los términos (en título o resumen) y las categorías.
export function buildSmartQuery(interp, forcedCategories, dateClause){
  const kw = interp.keywords.map(k => {
    const term = k.includes(' ') ? `"${k}"` : k;
    return `ti:${term} OR abs:${term}`;
  });
  const parts = ['(' + kw.join(' OR ') + ')'];
  const cats = (forcedCategories && forcedCategories.length) ? forcedCategories : interp.categories;
  if (cats.length) parts.push('(' + cats.map(c => 'cat:' + c).join(' OR ') + ')');
  if (dateClause) parts.push(dateClause);
  return parts.join(' AND ');
}

function cosine(a, b){
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++){ dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Paso 3: ordena los candidatos por parecido con lo que se busca. Si falla, deja el orden de arXiv.
export async function rerankByMeaning(env, entries, meaning){
  if (!entries.length || !env.AI || typeof env.AI.run !== 'function') return entries;
  try {
    const texts = [meaning].concat(entries.map(e => (e.title + '. ' + (e.abstract || '')).slice(0, 900)));
    const res = await withTimeout(env.AI.run(EMBED_MODEL, { text: texts }), EMBED_TIMEOUT_MS);
    const vecs = res && Array.isArray(res.data) ? res.data : null;
    if (!vecs || vecs.length !== texts.length) return entries;
    const q = vecs[0];
    return entries
      .map((e, i) => ({ e, s: cosine(q, vecs[i + 1]) }))
      .sort((x, y) => y.s - x.s)
      .map(x => x.e);
  } catch (e) {
    return entries;
  }
}
