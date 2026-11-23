// Llamada a un modelo de lenguaje de Workers AI, con respaldo.
//
// Cloudflare retira modelos cada cierto tiempo (Llama 3.1 8B dejó de responder el 30-05-2026 y
// rompió el resumen simple). Por eso se prueba una lista: si el primero falla o ya no existe, se
// usa el siguiente. Para cambiar de modelo en el futuro basta con editar MODELS.
const MODELS = [
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/zai-org/glm-4.7-flash'
];

function withTimeout(promise, ms){
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// Los modelos devuelven el texto en formatos distintos: { response }, estilo OpenAI { choices }, etc.
function extractText(res){
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (typeof res.response === 'string') return res.response;
  if (res.response && typeof res.response === 'object') return JSON.stringify(res.response);
  const c = res.choices && res.choices[0];
  if (c && c.message && typeof c.message.content === 'string') return c.message.content;
  if (c && typeof c.text === 'string') return c.text;
  if (res.result) return extractText(res.result);
  return '';
}

// Devuelve { text, model } o lanza el último error si ningún modelo respondió.
export async function runChat(env, messages, { maxTokens = 200, timeoutMs = 8000 } = {}){
  if (!env.AI || typeof env.AI.run !== 'function') throw new Error('no-ai');
  const started = Date.now();
  let lastError = new Error('no-model');
  for (const model of MODELS){
    const left = timeoutMs - (Date.now() - started);
    if (left < 1500) break;
    try {
      const res = await withTimeout(env.AI.run(model, {
        messages, max_tokens: maxTokens, temperature: 0.1,
        chat_template_kwargs: { enable_thinking: false }
      }), left);
      // Quita un posible bloque de "pensamiento" que algunos modelos agregan antes de la respuesta.
      const text = extractText(res).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (text) return { text, model };
      lastError = new Error(model + ': respuesta vacía');
    } catch (e) {
      lastError = new Error(model.split('/').pop() + ': ' + String(e && e.message || e).slice(0, 120));
    }
  }
  throw lastError;
}
