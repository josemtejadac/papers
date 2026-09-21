// GET /api/chat/inbox?device=<deviceId>
// Lista las conversaciones de esta persona: la sala pública "general" + sus mensajes directos,
// con el último mensaje y cuántos mensajes sin leer tiene en cada una.

import { json, getUser, DM_MEMBER_SQL, memberParam, dmMembers, handleOf } from '../../_lib/util.js';

export async function onRequestGet({ request, env }){
  const me = await getUser(env, new URL(request.url).searchParams.get('device'));
  if(!me) return json({ error: 'registro requerido' }, 401);

  const { results: convRows } = await env.DB.prepare(
    `SELECT conv_id, MAX(rowid) AS last_seq FROM messages
     WHERE conv_id = 'general' OR (conv_id LIKE 'dm:%' AND ${DM_MEMBER_SQL})
     GROUP BY conv_id ORDER BY last_seq DESC LIMIT 60`
  ).bind(memberParam(me.public_id)).all();

  const lastBySeq = new Map();
  if(convRows.length){
    const seqs = convRows.map(r => r.last_seq);
    const { results } = await env.DB.prepare(
      `SELECT rowid AS seq, * FROM messages WHERE rowid IN (${seqs.map(() => '?').join(',')})`
    ).bind(...seqs).all();
    results.forEach(r => lastBySeq.set(r.seq, r));
  }

  const dmIds = convRows.filter(r => r.conv_id !== 'general').map(r => r.conv_id);
  const unreadByConv = new Map();
  if(dmIds.length){
    const { results } = await env.DB.prepare(
      `SELECT m.conv_id AS conv_id, COUNT(*) AS c FROM messages m
       WHERE m.conv_id IN (${dmIds.map(() => '?').join(',')}) AND m.sender_id != ?
         AND m.rowid > COALESCE((SELECT last_read_seq FROM conv_reads WHERE device_id = ? AND conv_id = m.conv_id), 0)
       GROUP BY m.conv_id`
    ).bind(...dmIds, me.public_id, me.device_id).all();
    results.forEach(r => unreadByConv.set(r.conv_id, r.c));
  }

  const peerIds = new Set();
  dmIds.forEach(id => { const m = dmMembers(id); if(m) m.forEach(p => { if(p !== me.public_id) peerIds.add(p); }); });
  const peers = new Map();
  if(peerIds.size){
    const ids = Array.from(peerIds);
    const { results } = await env.DB.prepare(
      `SELECT public_id, name, tag, affiliation FROM users WHERE public_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    results.forEach(u => peers.set(u.public_id, u));
  }

  const mapLast = r => r ? { text: r.text, paperId: r.paper_id, senderId: r.sender_id, senderName: r.sender_name, createdAt: r.created_at } : null;
  const conversations = [];
  let unreadTotal = 0;

  const general = convRows.find(r => r.conv_id === 'general');
  conversations.push({ convId: 'general', kind: 'general', peer: null, last: mapLast(general && lastBySeq.get(general.last_seq)), unread: 0 });

  convRows.filter(r => r.conv_id !== 'general').forEach(r => {
    const members = dmMembers(r.conv_id) || [];
    const otherId = members.find(p => p !== me.public_id);
    const peer = peers.get(otherId);
    const unread = unreadByConv.get(r.conv_id) || 0;
    unreadTotal += unread;
    conversations.push({
      convId: r.conv_id, kind: 'dm',
      peer: { publicId: otherId, name: peer ? peer.name : 'Usuario', handle: peer ? handleOf(peer) : 'Usuario', affiliation: peer ? peer.affiliation : '' },
      last: mapLast(lastBySeq.get(r.last_seq)), unread
    });
  });

  return json({ conversations, unreadTotal });
}
