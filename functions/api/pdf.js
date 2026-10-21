// GET /api/pdf?id=2310.12345
//
// Retransmite el PDF real de un paper desde arxiv.org, pero servido desde nuestro propio dominio.
// Solo existe para que el Service Worker (mismo origen) pueda guardarlo en caché y mostrarlo sin
// conexión: un <a href="https://arxiv.org/..."> directo nunca pasa por nuestro Service Worker,
// porque es otro origen.

function isValidArxivId(id){
  // IDs modernos: 2310.12345 o 2310.12345v2. Legacy: astro-ph/0601001. Nunca ".." ni más de un "/".
  return typeof id === 'string' && id.length >= 3 && id.length <= 40
    && !id.includes('..')
    && /^[a-zA-Z0-9.\-]+(\/[a-zA-Z0-9.\-]+)?$/.test(id);
}

export async function onRequestGet({ request, env }){
  const id = new URL(request.url).searchParams.get('id');
  if(!isValidArxivId(id)){
    return new Response('id inválido', { status: 400 });
  }
  let upstream;
  try{
    upstream = await fetch('https://arxiv.org/pdf/' + id, {
      headers: { 'User-Agent': 'Abstracta/1.0 (papers app; Cloudflare Pages)' }
    });
  } catch(e){
    return new Response('no se pudo contactar a arXiv', { status: 502 });
  }
  if(!upstream.ok){
    return new Response('arXiv respondió con un error', { status: 502 });
  }
  const headers = new Headers();
  headers.set('content-type', 'application/pdf');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(upstream.body, { status: 200, headers });
}
