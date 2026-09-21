// GET  /api/social/posts?device=<deviceId>  -> lista de publicaciones (con likedByMe para ese device)
// POST /api/social/posts                    -> crea una publicación (usado por "Citar")
//
// Requiere un binding D1 llamado DB en la configuración del proyecto de Cloudflare Pages
// (Settings -> Functions -> D1 database bindings). Ver SETUP-SOCIAL-DB.md.

function jsonResponse(data, status){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function mapRow(row, likedIds){
  return {
    id: row.id,
    authorName: row.author_name,
    authorSub: row.author_sub,
    text: row.text,
    paperId: row.paper_id,
    quotedPostId: row.quoted_post_id,
    likes: row.likes,
    replies: row.replies,
    quotes: row.quotes,
    likedByMe: likedIds.has(row.id),
    createdAt: row.created_at
  };
}

export async function onRequestGet({ request, env }){
  const url = new URL(request.url);
  const device = url.searchParams.get('device') || '';

  const { results } = await env.DB.prepare(
    'SELECT * FROM posts ORDER BY created_at DESC, rowid DESC LIMIT 100'
  ).all();

  let likedIds = new Set();
  if(device && results.length){
    const ids = results.map(r=>r.id);
    const placeholders = ids.map(()=>'?').join(',');
    const likedRes = await env.DB.prepare(
      `SELECT post_id FROM post_likes WHERE device_id=? AND post_id IN (${placeholders})`
    ).bind(device, ...ids).all();
    likedIds = new Set(likedRes.results.map(r=>r.post_id));
  }

  return jsonResponse({ posts: results.map(r=>mapRow(r, likedIds)) });
}

export async function onRequestPost({ request, env }){
  const body = await request.json().catch(()=>null);
  if(!body || !body.text || !body.text.trim()){
    return jsonResponse({ error:'text es requerido' }, 400);
  }
  const authorName = (body.authorName || 'Anónimo').slice(0, 80);
  const authorSub = (body.authorSub || '').slice(0, 120);
  const text = body.text.trim().slice(0, 2000);
  const paperId = body.paperId || null;
  const quotedPostId = body.quotedPostId || null;
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  await env.DB.prepare(
    `INSERT INTO posts (id, author_name, author_sub, text, paper_id, quoted_post_id, likes, replies, quotes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, datetime('now'))`
  ).bind(id, authorName, authorSub, text, paperId, quotedPostId).run();

  if(quotedPostId){
    await env.DB.prepare('UPDATE posts SET quotes = quotes + 1 WHERE id = ?').bind(quotedPostId).run();
  }

  const row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  return jsonResponse({ post: mapRow(row, new Set()) }, 201);
}
