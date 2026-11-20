/** 画布文档操作：服务端与前端共用同一套语义，供 AI 助手和 MCP 复用。 */

const NODE_W = 260;
const nodeH = (n) => (n.type === 'text' ? 150 : 210);

const newId = () => `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

function autoXY(doc, i = 0) {
  const nodes = doc.nodes || [];
  if (!nodes.length) return { x: 420, y: 240 };
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
  const minY = Math.min(...nodes.map((n) => n.y));
  return { x: maxX + 80, y: minY + i * 260 };
}

function pruneLinks(doc) {
  const ids = new Set((doc.nodes || []).map((n) => n.id));
  return { ...doc, links: (doc.links || []).filter((l) => ids.has(l.from) && ids.has(l.to)) };
}

/**
 * 纯函数：在 doc 上执行一批操作，返回新 doc 与执行计数。
 * 支持：add_text / add_image / add_video / set_text / move / link / delete
 * 每个 add 可带 as 别名，同批次内 link 可用别名引用。
 */
export function applyOps(inputDoc, ops) {
  let doc = { nodes: [], links: [], ...(inputDoc || {}) };
  const alias = {};
  const resolve = (ref) => alias[ref] || ref;
  const errors = [];
  let applied = 0;

  (Array.isArray(ops) ? ops : []).forEach((op, i) => {
    if (!op || typeof op !== 'object') return;
    const kind = op.op;
    try {
      if (kind === 'add_text' || kind === 'add_image' || kind === 'add_video') {
        const type = kind === 'add_text' ? 'text' : kind === 'add_image' ? 'image' : 'video';
        const pos = (op.x == null || op.y == null) ? autoXY(doc, i) : { x: Number(op.x), y: Number(op.y) };
        const node = {
          id: newId(),
          type,
          x: pos.x,
          y: pos.y,
          text: op.text || '',
          label: type === 'text' ? '文本' : type === 'image' ? '图片' : '视频',
        };
        if (op.as) alias[op.as] = node.id;
        doc = { ...doc, nodes: [...doc.nodes, node] };
        applied += 1;
      } else if (kind === 'set_text' && op.id) {
        const id = resolve(op.id);
        doc = { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, text: String(op.text ?? '') } : n)) };
        applied += 1;
      } else if (kind === 'move' && op.id) {
        const id = resolve(op.id);
        doc = {
          ...doc,
          nodes: doc.nodes.map((n) => (n.id === id
            ? { ...n, x: Number(op.x) || n.x, y: Number(op.y) || n.y }
            : n)),
        };
        applied += 1;
      } else if (kind === 'link' && op.from && op.to) {
        const from = resolve(op.from);
        const to = resolve(op.to);
        if (from !== to && doc.nodes.some((n) => n.id === from) && doc.nodes.some((n) => n.id === to)) {
          const exists = (doc.links || []).some((l) => l.from === from && l.to === to);
          if (!exists) doc = { ...doc, links: [...(doc.links || []), { from, to }] };
          applied += 1;
        }
      } else if (kind === 'delete' && op.id) {
        const id = resolve(op.id);
        doc = pruneLinks({ ...doc, nodes: doc.nodes.filter((n) => n.id !== id) });
        applied += 1;
      } else if (kind === 'generate_video') {
        // 生成需要计费与上游交互，交给调用方处理，这里只登记占位节点
        const pos = (op.x == null || op.y == null) ? autoXY(doc, i) : { x: Number(op.x), y: Number(op.y) };
        const node = {
          id: newId(),
          type: 'video',
          x: pos.x,
          y: pos.y,
          text: String(op.text || ''),
          label: '视频',
          jobId: op.jobId || null,
          status: op.jobId ? 'running' : 'idle',
          mediaUrl: null,
        };
        if (op.as) alias[op.as] = node.id;
        doc = { ...doc, nodes: [...doc.nodes, node] };
        applied += 1;
      } else {
        errors.push(`未识别的操作：${kind}`);
      }
    } catch (e) {
      errors.push(`操作 ${kind} 失败：${e.message}`);
    }
  });

  return { doc: pruneLinks(doc), applied, errors, alias };
}
