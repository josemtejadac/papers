// GET /api/pdf?id=2310.12345
//
// Retransmite el PDF real de un paper desde arxiv.org, pero servido desde nuestro propio dominio.
// Solo existe para que el Service Worker (mismo origen) pueda guardarlo en caché y mostrarlo sin
// conexión: un <a href="https://arxiv.org/..."> directo nunca pasa por nuestro Service Worker,
// porque es otro origen.
//
// El PDF de una versión de un paper no cambia, así que también se guarda en la caché del borde
// de Cloudflare: la segunda persona que lo pide ya no hace ir a buscarlo a arXiv.

import { safe } from '../_lib/util.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isValidArxivId(id){
  // IDs modernos: 2310.12345 o 2310.12345v2. Legacy: astro-ph/0601001. Nunca ".." ni más de un "/".
  return typeof id === 'string' && id.length >= 3 && id.length <= 40
    && !id.includes('..')
    && /^[a-zA-Z0-9.\-]+(\/[a-zA-Z0-9.\-]+)?$/.test(id);
}

async function fetchPdf(id){
  let last = null;
  for(let attempt = 0; attempt < 2; attempt++){
    try{
      const res = await fetch('https://arxiv.org/pdf/' + id, {
        headers: { 'User-Agent': 'Abstracta/1.0 (papers app; Cloudflare Pages)' },
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 2592000, '300-599': 0 } }
      });
      if(res.ok) return res;
      last = res;
      if(res.status !== 429 && res.status < 500) return res; // p. ej. 404: no sirve reintentar
    } catch(e){
      last = null;
    }
    if(attempt === 0) await sleep(1500);
  }
  return last;
}

async function handleGet({ request }){
  const id = new URL(request.url).searchParams.get('id');
  if(!isValidArxivId(id)){
    return new Response('id inválido', { status: 400 });
  }
  const upstream = await fetchPdf(id);
  if(!upstream){
    return new Response('No se pudo contactar a arXiv. Intenta de nuevo en un momento.', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if(upstream.status === 404){
    return new Response('Ese paper no tiene PDF disponible en arXiv.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if(!upstream.ok){
    return new Response('arXiv no está respondiendo en este momento. Intenta de nuevo en un rato.', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const headers = new Headers();
  headers.set('content-type', 'application/pdf');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(upstream.body, { status: 200, headers });
}

export const onRequestGet = safe(handleGet);
