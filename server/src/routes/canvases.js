import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { db, uid, now } from '../db.js';
import { applyOps } from '../canvasDoc.js';

const r = Router();

const EMPTY = '{"nodes":[],"links":[]}';

const shape = (row) => {
  let doc = { nodes: [], links: [] };
  try { doc = JSON.parse(row.doc || EMPTY); } catch { /* 保持空文档 */ }
  return {
    id: row.id,
    name: row.name,
    doc,
    nodes: (doc.nodes || []).length,
    links: (doc.links || []).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

function ownCanvas(user, id) {
  const row = db.prepare('SELECT * FROM canvases WHERE id = ?').get(id);
  if (!row) return { error: [404, '画布不存在'] };
  if (row.user_id !== user.id && user.role !== 'admin') return { error: [403, '无权访问该画布'] };
  return { row };
}

/** 列表（附带第一个默认画布，方便前端启动即用） */
r.get('/canvases', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM canvases WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.json({ items: rows.map((row) => shape({ ...row, doc: undefined })) , canvases: rows.map(shape) });
});

/** 新建 */
r.post('/canvases', requireAuth, (req, res) => {
  const name = String(req.body?.name || '主画布').slice(0, 40);
  const doc = req.body?.doc && typeof req.body.doc === 'object'
    ? JSON.stringify(req.body.doc)
    : EMPTY;
  const id = uid('cv_');
  const t = now();
  db.prepare('INSERT INTO canvases(id,user_id,name,doc,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, req.user.id, name, doc, t, t);
  res.json({ canvas: shape(db.prepare('SELECT * FROM canvases WHERE id = ?').get(id)) });
});

/** 取单个 */
r.get('/canvases/:id', requireAuth, (req, res) => {
  const { row, error } = ownCanvas(req.user, req.params.id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  res.json({ canvas: shape(row) });
});

/** 整体保存 */
r.put('/canvases/:id', requireAuth, (req, res) => {
  const { row, error } = ownCanvas(req.user, req.params.id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const doc = req.body?.doc;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.nodes)) {
    return res.status(400).json({ error: 'doc 格式不对，需要 { nodes: [], links: [] }' });
  }
  const name = req.body?.name ? String(req.body.name).slice(0, 40) : row.name;
  db.prepare('UPDATE canvases SET doc = ?, name = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(doc), name, now(), row.id);
  res.json({ ok: true, canvas: shape(db.prepare('SELECT * FROM canvases WHERE id = ?').get(row.id)) });
});

/**
 * 增量操作：AI 助手与 MCP 都走这里，保证语义一致。
 * body: { ops: [...] }
 */
r.post('/canvases/:id/ops', requireAuth, (req, res) => {
  const { row, error } = ownCanvas(req.user, req.params.id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const ops = req.body?.ops;
  if (!Array.isArray(ops) || !ops.length) return res.status(400).json({ error: 'ops 不能为空' });

  let current = { nodes: [], links: [] };
  try { current = JSON.parse(row.doc || EMPTY); } catch { /* 用空文档兜底 */ }

  const result = applyOps(current, ops);
  db.prepare('UPDATE canvases SET doc = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(result.doc), now(), row.id);

  res.json({
    ok: true,
    applied: result.applied,
    errors: result.errors,
    alias: result.alias,
    canvas: shape(db.prepare('SELECT * FROM canvases WHERE id = ?').get(row.id)),
  });
});

/** 删除 */
r.delete('/canvases/:id', requireAuth, (req, res) => {
  const { row, error } = ownCanvas(req.user, req.params.id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  db.prepare('DELETE FROM canvases WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

export default r;
