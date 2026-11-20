import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Type, Image as ImageIcon, Video, Trash2, ZoomIn, ZoomOut, Maximize, Loader2, X, Sparkles,
  MousePointer2, Hand, ImagePlus, ChevronDown, Map as MapIcon, Expand,
  MessageSquare, Send, Bot,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.jsx';
import { useToast } from '../components/ui.jsx';

const STORE_KEY = 'xm_canvas_v1';

const NODE_W = 260;
const NODE_H = 170;
const nodeH = (n) => (n.type === 'text' ? 150 : 210);

const AGENT_SYS = `你是「无限画布」的画布助手，用中文简洁回答。
画布节点结构：{id, type, x, y, text}，type 为 text / image / video。
当用户要求改动画布时，输出且只输出一个 json 代码块，格式 {"ops":[...]}，可用操作：
{"op":"add_text","x":0,"y":0,"text":"内容","as":"s1"}       新建文本节点，as 是本次批次的别名（可省略）
{"op":"add_image","x":0,"y":0,"as":"s2"}                    新建图片节点
{"op":"add_video","x":0,"y":0,"text":"提示词","as":"s3"}    新建视频节点（仅占位，不提交生成）
{"op":"set_text","id":"真实id","text":"新内容"}             改写节点文字
{"op":"move","id":"真实id","x":0,"y":0}                     移动节点
{"op":"link","from":"s1","to":"s2"}                         连线，from/to 可填别名或真实 id
{"op":"delete","id":"真实id"}                               删除节点
{"op":"generate_video","text":"提示词","duration":5,"size":"16:9","x":0,"y":0,"as":"v1"} 提交视频生成
规则：
1 只使用用户消息里给出的真实 id 或本批次自己起的别名，不要编造。
2 新建节点坐标自己算，横向间隔 320、纵向间隔 260，避免重叠。
3 必须用 json 代码围栏包裹整个对象（三个反引号开头写 json），代码块外不要重复 JSON。
4 用户说"连起来/串起来/接上"时，必须输出对应数量的 link 操作，按顺序首尾相连，用别名引用。
5 用户只是问提示词怎么写，就不要输出 ops，直接把提示词给他。
6 普通回答不要输出 json。`;

let seq = 1;
const newId = () => `n_${Date.now().toString(36)}_${seq++}`;

const defaultDoc = () => ({
  nodes: [
    {
      id: newId(),
      type: 'text',
      x: 420,
      y: 240,
      text: '输入或从下方输入区写入',
      label: '文本1',
    },
  ],
  links: [],
});

export default function Canvas() {
  const { user, refresh } = useAuth();
  const toast = useToast();

  const [doc, setDoc] = useState(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return defaultDoc();
  });

  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [selected, setSelected] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(true);
  const [duration, setDuration] = useState(5);
  const [size, setSize] = useState('16:9');
  const [tool, setTool] = useState('select'); // select | hand
  const [vpSize, setVpSize] = useState({ w: 800, h: 500 });

  const viewportRef = useRef(null);
  const dragRef = useRef(null); // { mode:'pan'|'node'|'link', ... }
  const bootRef = useRef(false);
  const viewRef = useRef(view);
  const docRef = useRef(doc);
  viewRef.current = view;
  docRef.current = doc;
  const [linking, setLinking] = useState(null); // { from, x, y } 拖拽中的临时连线
  const [editingId, setEditingId] = useState(null); // 就地编辑的节点
  const [aiBusy, setAiBusy] = useState(null); // 正在润色的节点 id（null 表示底部输入框）

  /* 侧边 AI 助手 */
  const [agentOpen, setAgentOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [agentInput, setAgentInput] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const msgEndRef = useRef(null);

  // 首次进入默认选中第一个节点（对齐原站的高亮态）
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (doc.nodes.length) setSelected([doc.nodes[0].id]);
  }, [doc.nodes]);

  /* ---------------- 持久化：服务端为主，localStorage 作离线缓存 ---------------- */
  const [canvasId, setCanvasId] = useState(null);
  const [ready, setReady] = useState(false);
  const canvasIdRef = useRef(null);
  canvasIdRef.current = canvasId;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { canvases } = await api.canvases();
        let current = canvases && canvases[0];
        if (!current) {
          const created = await api.createCanvas({ name: '主画布', doc });
          current = created.canvas;
        } else if (current.nodes === 0 && doc.nodes.length) {
          // 服务端是空的、本地还有内容 → 把本地内容推上去
          await api.saveCanvas(current.id, { doc });
        }
        if (!alive) return;
        setCanvasId(current.id);
        if (current.doc && Array.isArray(current.doc.nodes) && current.doc.nodes.length) {
          setDoc(current.doc);
        }
      } catch {
        // 接口不可用时退回纯本地模式，不影响使用
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    setSaved(false);
    const t = setTimeout(async () => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(doc));
        if (canvasIdRef.current) await api.saveCanvas(canvasIdRef.current, { doc });
        setSaved(true);
      } catch {
        setSaved(true);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [doc, ready]);

  /* ---------------- 选中节点 ↔ 底部输入框 联动 ---------------- */
  const singleSelected = selected.length === 1 ? doc.nodes.find((n) => n.id === selected[0]) : null;

  useEffect(() => {
    if (singleSelected) setPrompt(singleSelected.text || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleSelected?.id]);

  const setNodeText = (id, text) =>
    setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, text } : n)) }));

  const onPromptChange = (v) => {
    setPrompt(v);
    if (singleSelected) setNodeText(singleSelected.id, v);
  };

  /* ---------------- AI 提示词润色 ---------------- */
  const AI_SYS =
    '你是短视频分镜提示词专家。把用户的草稿改写成一条可直接用于 AI 视频生成的中文提示词：'
    + '保留原意，补上镜头运动、主体动作、环境与光线、画面质感；一个镜头只写一个主动作；'
    + '全角标点，严格控制在 140 字以内；只输出提示词本身，不要解释、不要加引号或前缀。';

  const aiRefine = async (nodeId = null) => {
    const src = nodeId ? (doc.nodes.find((n) => n.id === nodeId)?.text || '') : prompt;
    const seed = String(src).trim();
    if (seed.length < 2) return toast('先写点内容再润色', 'error');
    setAiBusy(nodeId ?? 'prompt');
    try {
      const { content } = await api.chat({
        model: 'muse-spark',
        messages: [
          { role: 'system', content: AI_SYS },
          { role: 'user', content: seed },
        ],
      });
      const t = String(content || '').trim();
      if (!t) throw new Error('模型没有返回内容');
      if (nodeId) {
        setNodeText(nodeId, t);
      } else {
        setPrompt(t);
        if (singleSelected) setNodeText(singleSelected.id, t);
      }
      toast('提示词已润色', 'ok');
    } catch (e) {
      toast(e.message || '润色失败', 'error');
    } finally {
      setAiBusy(null);
    }
  };

  /* ---------------- 侧边助手：把画布状态喂给模型 ---------------- */
  const canvasContext = () => {
    const ns = docRef.current.nodes.slice(0, 40).map((n) => ({
      id: n.id,
      type: n.type,
      x: Math.round(n.x),
      y: Math.round(n.y),
      text: (n.text || '').slice(0, 60),
    }));
    return `当前画布节点：${JSON.stringify(ns)}`;
  };

  const parseOps = (content) => {
    let text = String(content || '').trim();
    let ops = [];

    // 1) 优先解析 ```json 代码块
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        const o = JSON.parse(fenced[1].trim());
        ops = Array.isArray(o) ? o : (o.ops || []);
        text = text.replace(fenced[0], '').trim();
      } catch { ops = []; }
    }

    // 2) 兼容不带围栏的裸 JSON（模型经常这样输出）
    if (!ops.length) {
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s >= 0 && e > s) {
        try {
          const o = JSON.parse(text.slice(s, e + 1));
          const arr = Array.isArray(o) ? o : (o.ops || []);
          if (Array.isArray(arr) && arr.length && arr.every((x) => x && typeof x.op === 'string')) {
            ops = arr;
            text = `${text.slice(0, s)}${text.slice(e + 1)}`.trim();
          }
        } catch { /* 不是 JSON，当普通文本 */ }
      }
    }

    if (/^json$/i.test(text)) text = '';
    return { text, ops: Array.isArray(ops) ? ops : [] };
  };

  const autoXY = (i = 0) => {
    const nodes = docRef.current.nodes;
    if (!nodes.length) return { x: 420, y: 240 };
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
    const minY = Math.min(...nodes.map((n) => n.y));
    return { x: maxX + 80, y: minY + i * 260 };
  };

  const applyOps = async (ops) => {
    let done = 0;
    const alias = {}; // 本批次别名 -> 真实节点 id
    const resolve = (ref) => alias[ref] || ref;
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i] || {};
      try {
        if (op.op === 'add_text' || op.op === 'add_image' || op.op === 'add_video') {
          const type = op.op === 'add_text' ? 'text' : op.op === 'add_image' ? 'image' : 'video';
          const pos = (op.x == null || op.y == null) ? autoXY(i) : { x: Number(op.x), y: Number(op.y) };
          const n = {
            id: newId(),
            type,
            x: pos.x,
            y: pos.y,
            text: op.text || '',
            label: type === 'text' ? '文本' : type === 'image' ? '图片' : '视频',
          };
          if (op.as) alias[op.as] = n.id;
          setDoc((d) => ({ ...d, nodes: [...d.nodes, n] }));
          done += 1;
        } else if (op.op === 'set_text' && op.id) {
          setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === resolve(op.id) ? { ...n, text: String(op.text ?? '') } : n)) }));
          done += 1;
        } else if (op.op === 'move' && op.id) {
          setDoc((d) => ({
            ...d,
            nodes: d.nodes.map((n) => (n.id === resolve(op.id) ? { ...n, x: Number(op.x) || n.x, y: Number(op.y) || n.y } : n)),
          }));
          done += 1;
        } else if (op.op === 'link' && op.from && op.to) {
          addLink(resolve(op.from), resolve(op.to));
          done += 1;
        } else if (op.op === 'delete' && op.id) {
          setDoc((d) => pruneLinks({ ...d, nodes: d.nodes.filter((n) => n.id !== resolve(op.id)) }));
          done += 1;
        } else if (op.op === 'generate_video' && op.text) {
          // eslint-disable-next-line no-await-in-loop
          const job = await api.createVideo({
            prompt: String(op.text),
            duration: Number(op.duration) || 5,
            size: op.size || '16:9',
            images: [],
          });
          const pos = (op.x == null || op.y == null) ? autoXY(i) : { x: Number(op.x), y: Number(op.y) };
          const n = {
            id: newId(),
            type: 'video',
            x: pos.x,
            y: pos.y,
            text: String(op.text),
            label: '视频',
            jobId: job.id,
            status: 'running',
            mediaUrl: null,
          };
          if (op.as) alias[op.as] = n.id;
          setDoc((d) => ({ ...d, nodes: [...d.nodes, n] }));
          done += 1;
        }
      } catch (e) {
        toast(`操作 ${op.op} 失败：${e.message}`, 'error');
      }
    }
    return done;
  };

  const sendAgent = async () => {
    const q = agentInput.trim();
    if (!q || agentBusy) return;
    const history = [...msgs, { role: 'user', content: q }];
    setMsgs(history);
    setAgentInput('');
    setAgentBusy(true);
    try {
      const { content } = await api.chat({
        model: 'muse-spark',
        messages: [
          { role: 'system', content: AGENT_SYS },
          { role: 'system', content: canvasContext() },
          ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        ],
      });
      const { text, ops } = parseOps(String(content || ''));
      let applied = 0;
      if (ops.length) {
        if (canvasIdRef.current) {
          // 走服务端执行：语义与 MCP 完全一致
          const r = await api.canvasOps(canvasIdRef.current, ops);
          if (r?.canvas?.doc) setDoc(r.canvas.doc);
          applied = r?.applied ?? ops.length;
          if (r?.errors?.length) r.errors.forEach((x) => toast(x, 'error'));
        } else {
          applied = await applyOps(ops);
        }
      }
      setMsgs([...history, {
        role: 'assistant',
        content: text || (applied ? '好的，已按要求更新画布。' : '（没有内容）'),
        note: applied ? `已执行 ${applied} 个画布操作` : null,
      }]);
      if (applied) refresh();
    } catch (e) {
      setMsgs([...history, { role: 'assistant', content: `出错了：${e.message}` }]);
    } finally {
      setAgentBusy(false);
    }
  };

  useEffect(() => {
    if (agentOpen) msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, agentOpen, agentBusy]);

  /* ---------------- 视口变换 ---------------- */
  const screenToCanvas = (clientX, clientY) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - view.x) / view.z,
      y: (clientY - rect.top - view.y) / view.z,
    };
  };

  const zoomBy = (factor, cx, cy) => {
    setView((v) => {
      const z = Math.min(2.5, Math.max(0.25, v.z * factor));
      const rect = viewportRef.current?.getBoundingClientRect();
      const px = cx ?? (rect ? rect.width / 2 : 0);
      const py = cy ?? (rect ? rect.height / 2 : 0);
      // 以光标为中心缩放
      const nx = px - ((px - v.x) / v.z) * z;
      const ny = py - ((py - v.y) / v.z) * z;
      return { x: nx, y: ny, z };
    });
  };

  const onWheel = (e) => {
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left : undefined;
    const cy = rect ? e.clientY - rect.top : undefined;
    zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08, cx, cy);
  };

  /* ---------------- 拖拽 ---------------- */
  const onBackgroundDown = (e) => {
    if (e.button === 2) return;
    const isMiddle = e.button === 1;
    const isSpace = e.getModifierState?.(' ') || false;
    // 只有空白处、中键、按住空格时平移
    if (tool !== 'hand' && !isMiddle && !isSpace && e.target !== e.currentTarget && !e.target.dataset.canvasbg) return;
    setSelected([]);
    dragRef.current = {
      mode: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      ox: view.x,
      oy: view.y,
    };
  };

  const onNodeDown = (e, node) => {
    if (tool === 'hand') return; // 抓手模式：交给画布平移
    e.stopPropagation();
    if (e.button === 2) return;
    const multi = e.shiftKey;
    setSelected((sel) => {
      if (multi) return sel.includes(node.id) ? sel.filter((i) => i !== node.id) : [...sel, node.id];
      return sel.includes(node.id) ? sel : [node.id];
    });
    dragRef.current = {
      mode: 'node',
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      nodeX: node.x,
      nodeY: node.y,
      ids: multi ? [...selected, node.id] : [node.id],
      origins: {},
    };
    // 记录所有选中节点原位置
    if (multi) {
      const origins = {};
      for (const n of doc.nodes) {
        if (selected.includes(n.id) || n.id === node.id) origins[n.id] = { x: n.x, y: n.y };
      }
      dragRef.current.origins = origins;
    }
  };

  /* ---------------- 手动连线 ---------------- */
  const startLink = (e, node) => {
    if (e.button === 2) return;
    e.stopPropagation();
    const v = viewRef.current;
    const rect = viewportRef.current?.getBoundingClientRect();
    const origin = {
      x: node.x + NODE_W,
      y: node.y + nodeH(node) / 2,
    };
    dragRef.current = { mode: 'link', from: node.id };
    setLinking({ from: node.id, x: origin.x, y: origin.y });
    // 记录鼠标原位，避免首帧跳动
    if (rect) {
      setLinking({
        from: node.id,
        x: (e.clientX - rect.left - v.x) / v.z,
        y: (e.clientY - rect.top - v.y) / v.z,
      });
    }
  };

  const hitNode = (pt, excludeId) => {
    const nodes = docRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const n = nodes[i];
      if (n.id === excludeId) continue;
      if (pt.x >= n.x && pt.x <= n.x + NODE_W && pt.y >= n.y && pt.y <= n.y + nodeH(n)) return n;
    }
    return null;
  };

  const addLink = (from, to) => {
    if (!from || !to || from === to) return;
    setDoc((d) => {
      const exists = (d.links || []).some((l) => l.from === from && l.to === to);
      if (exists) return d;
      return { ...d, links: [...(d.links || []), { from, to }] };
    });
  };

  const removeLink = (from, to) => {
    setDoc((d) => ({ ...d, links: (d.links || []).filter((l) => !(l.from === from && l.to === to)) }));
  };

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;

      if (d.mode === 'pan') {
        setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
      } else if (d.mode === 'node') {
        const cdx = dx / view.z;
        const cdy = dy / view.z;
        setDoc((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => {
            if (d.origins && d.origins[n.id]) {
              return { ...n, x: d.origins[n.id].x + cdx, y: d.origins[n.id].y + cdy };
            }
            if (n.id === d.id) return { ...n, x: d.nodeX + cdx, y: d.nodeY + cdy };
            return n;
          }),
        }));
      } else if (d.mode === 'link') {
        const v = viewRef.current;
        const rect = viewportRef.current?.getBoundingClientRect();
        if (rect) {
          setLinking({
            from: d.from,
            x: (e.clientX - rect.left - v.x) / v.z,
            y: (e.clientY - rect.top - v.y) / v.z,
          });
        }
      }
    };
    const onUp = (e) => {
      const d = dragRef.current;
      if (d?.mode === 'link') {
        const v = viewRef.current;
        const rect = viewportRef.current?.getBoundingClientRect();
        if (rect) {
          const pt = {
            x: (e.clientX - rect.left - v.x) / v.z,
            y: (e.clientY - rect.top - v.y) / v.z,
          };
          const target = hitNode(pt, d.from);
          if (target) addLink(d.from, target.id);
        }
        setLinking(null);
      }
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [view.z]);

  /* ---------------- 键盘 ---------------- */
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selected.length) return;
        e.preventDefault();
        setDoc((d) => pruneLinks({ ...d, nodes: d.nodes.filter((n) => !selected.includes(n.id)) }));
        setSelected([]);
      }
      if (e.key === 'v' || e.key === 'V') setTool('select');
      if (e.key === 'h' || e.key === 'H') setTool('hand');
      if (e.key === 'Escape') {
        dragRef.current = null;
        setLinking(null);
        setSelected([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  /* ---------------- 节点操作 ---------------- */
  const addNode = (type) => {
    const center = screenToCanvas(
      (viewportRef.current?.getBoundingClientRect().left ?? 0) + (viewportRef.current?.clientWidth ?? 400) / 2,
      (viewportRef.current?.getBoundingClientRect().top ?? 0) + (viewportRef.current?.clientHeight ?? 300) / 2
    );
    const n = {
      id: newId(),
      type,
      x: Math.round(center.x - NODE_W / 2 + (Math.random() * 40 - 20)),
      y: Math.round(center.y - NODE_H / 2 + (Math.random() * 40 - 20)),
      text: type === 'text' ? '双击输入或从下方输入区写入' : '',
      label: type === 'text' ? '文本' : type === 'image' ? '图片' : '视频',
    };
    setDoc((d) => ({ ...d, nodes: [...d.nodes, n] }));
    setSelected([n.id]);
  };

  const removeSelected = () => {
    setDoc((d) => pruneLinks({ ...d, nodes: d.nodes.filter((n) => !selected.includes(n.id)) }));
    setSelected([]);
  };

  const fitView = () => {
    if (!doc.nodes.length) return setView({ x: 0, y: 0, z: 1 });
    const minX = Math.min(...doc.nodes.map((n) => n.x));
    const minY = Math.min(...doc.nodes.map((n) => n.y));
    const maxX = Math.max(...doc.nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...doc.nodes.map((n) => n.y + nodeH(n)));
    const rect = viewportRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 500;
    const z = Math.min(1.4, Math.max(0.3, Math.min(w / (maxX - minX + 160), h / (maxY - minY + 160))));
    setView({
      x: w / 2 - ((minX + maxX) / 2) * z,
      y: h / 2 - ((minY + maxY) / 2) * z,
      z,
    });
  };

  /* ---------------- 生成 ---------------- */
  const generate = async () => {
    if (prompt.trim().length < 2) return toast('请先输入文本内容', 'error');
    if ((user?.credits ?? 0) < 10 + 2 * duration) return toast('积分不足', 'error');

    const bound = selected.length === 1 ? doc.nodes.find((n) => n.id === selected[0]) : null;
    setBusy(true);
    try {
      const { job } = await api.createVideo({
        prompt: prompt.trim(),
        duration,
        size,
        images: [],
      });

      const node = {
        id: newId(),
        type: 'video',
        x: bound ? bound.x + NODE_W + 60 : 520,
        y: bound ? bound.y : 300,
        text: prompt.trim(),
        label: '视频',
        jobId: job.id,
        status: 'running',
        mediaUrl: null,
      };
      setDoc((d) => ({
        ...d,
        nodes: [...d.nodes, node],
        links: bound ? [...(d.links || []), { from: bound.id, to: node.id }] : d.links || [],
      }));
      setSelected([node.id]);
      setPrompt('');
      toast('节点已提交生成', 'ok');
      refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 任务轮询 ---------------- */
  const syncJobs = useCallback(async () => {
    const running = doc.nodes.filter((n) => n.jobId && n.status === 'running');
    if (!running.length) return;
    const results = await Promise.all(
      running.map(async (n) => {
        try { return { id: n.id, job: (await api.job(n.jobId)).job }; } catch { return null; }
      })
    );
    setDoc((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const hit = results.find((r) => r?.id === n.id)?.job;
        if (!hit) return n;
        if (hit.status === 'completed') {
          return { ...n, status: 'done', mediaUrl: hit.mediaUrl || hit.result?.url };
        }
        if (hit.status === 'failed') {
          return { ...n, status: 'failed', error: hit.error };
        }
        return { ...n, progress: hit.progress };
      }),
    }));
  }, [doc.nodes]);

  useEffect(() => {
    const hasRunning = doc.nodes.some((n) => n.jobId && n.status === 'running');
    if (!hasRunning) return undefined;
    const t = setInterval(syncJobs, 2500);
    return () => clearInterval(t);
  }, [doc.nodes, syncJobs]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setVpSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const boundNode = selected.length === 1 ? doc.nodes.find((n) => n.id === selected[0]) : null;

  const nodeById = Object.fromEntries(doc.nodes.map((n) => [n.id, n]));
  const links = (doc.links || []).filter((l) => nodeById[l.from] && nodeById[l.to]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------------- 标题 ---------------- */}
      <div className="flex shrink-0 items-center justify-between gap-4 px-7 pb-3 pt-5">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-white">
            无限画布
            <span className="h-2 w-2 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(79,227,193,.8)]" />
          </h1>
          <p className="mt-1 text-[12.5px] text-mist-400">在无限画布中自由组织创意与生成视频</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAgentOpen((v) => !v)}
            className={clsx(
              'flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[12.5px] transition',
              agentOpen
                ? 'border-brand-400/40 bg-brand-400/10 text-brand-200'
                : 'border-white/[0.08] text-mist-200 hover:border-brand-400/30 hover:text-white'
            )}
          >
            <MessageSquare size={14} /> AI 助手
          </button>
          <span className="flex items-center gap-1.5 text-[11.5px] text-mist-400">
            <span className={clsx('h-1.5 w-1.5 rounded-full', saved ? 'bg-brand-400' : 'bg-mist-400')} />
            {saved ? '已自动保存' : '保存中…'}
          </span>
        </div>
      </div>

      {/* ---------------- 画布 ---------------- */}
      <div className="relative mx-5 mb-5 min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/[0.06]">
        {/* 视图 */}
        <div
          ref={viewportRef}
          data-canvasbg="1"
          onWheel={onWheel}
          onMouseDown={onBackgroundDown}
          onContextMenu={(e) => e.preventDefault()}
          className={clsx('dot-grid absolute inset-0 select-none', tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default')}
          style={{
            backgroundSize: `${22 * view.z}px ${22 * view.z}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
          >
            {/* 连线 */}
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
              {links.map((l) => {
                const a = nodeById[l.from];
                const b = nodeById[l.to];
                const x1 = a.x + NODE_W;
                const y1 = a.y + nodeH(a) / 2;
                const x2 = b.x;
                const y2 = b.y + nodeH(b) / 2;
                const mx = (x1 + x2) / 2;
                const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
                return (
                  <g key={l.from + l.to}>
                    <path d={d} fill="none" stroke="rgba(184,192,208,.45)" strokeWidth="1.5" strokeDasharray="5 5" />
                    {/* 加粗的透明命中区：悬停高亮，双击删除 */}
                    <path
                      d={d}
                      fill="none"
                      stroke="rgba(0,0,0,0)"
                      strokeWidth="14"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onMouseEnter={(e) => { e.currentTarget.setAttribute('stroke', 'rgba(239,68,68,.28)'); }}
                      onMouseLeave={(e) => { e.currentTarget.setAttribute('stroke', 'rgba(0,0,0,0)'); }}
                      onDoubleClick={() => removeLink(l.from, l.to)}
                    />
                  </g>
                );
              })}
              {linking && (() => {
                const src = nodeById[linking.from];
                if (!src) return null;
                const x1 = src.x + NODE_W;
                const y1 = src.y + nodeH(src) / 2;
                const mx = (x1 + linking.x) / 2;
                return (
                  <path
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${linking.y} ${linking.x},${linking.y}`}
                    fill="none"
                    stroke="rgba(79,227,193,.9)"
                    strokeWidth="2"
                    strokeDasharray="6 4"
                  />
                );
              })()}
            </svg>

            {doc.nodes.map((n) => (
              <CanvasNode
                key={n.id}
                node={n}
                active={selected.includes(n.id)}
                onMouseDown={(e) => onNodeDown(e, n)}
                onPortDown={(e) => startLink(e, n)}
                editing={editingId === n.id}
                aiBusy={aiBusy === n.id}
                onStartEdit={() => { setSelected([n.id]); setEditingId(n.id); }}
                onTextChange={(v) => setNodeText(n.id, v)}
                onEndEdit={() => setEditingId(null)}
                onAi={() => aiRefine(n.id)}
              />
            ))}
          </div>
        </div>

        {/* 顶部工具栏 */}
        <div className="absolute left-4 top-4 z-20 flex items-center gap-1 rounded-2xl border border-white/[0.07] bg-[#121726]/90 p-1.5 shadow-xl backdrop-blur">
          <ToolBtn icon={MousePointer2} active={tool === 'select'} onClick={() => setTool('select')} title="选择 (V)" />
          <ToolBtn icon={Hand} active={tool === 'hand'} onClick={() => setTool('hand')} title="抓手 (H)" />
          <Sep />
          <ToolBtn icon={Type} onClick={() => addNode('text')} title="新建文本节点" />
          <ToolBtn icon={ImageIcon} onClick={() => addNode('image')} title="新建图片节点" />
          <ToolBtn icon={Video} onClick={() => addNode('video')} title="新建视频节点" />
          <Sep />
          <ToolBtn icon={ZoomOut} onClick={() => zoomBy(1 / 1.15)} title="缩小" />
          <button
            onClick={() => setView((v) => ({ ...v, z: 1 }))}
            title="重置为 100%"
            className="flex h-9 min-w-[70px] items-center justify-center gap-1 rounded-xl border border-white/[0.06] px-2 font-mono text-[12px] text-mist-200 hover:text-white"
          >
            {Math.round(view.z * 100)}% <ChevronDown size={12} className="text-mist-400" />
          </button>
          <ToolBtn icon={ZoomIn} onClick={() => zoomBy(1.15)} title="放大" />
          <Sep />
          <ToolBtn icon={Maximize} onClick={fitView} title="适应画布" />
          <ToolBtn icon={Trash2} onClick={removeSelected} disabled={!selected.length} danger title="删除选中 (Delete)" />
        </div>

        <span className="pointer-events-none absolute right-4 top-5 z-20 hidden font-mono text-[10px] text-mist-400/70 xl:block">
          滚轮缩放 · 中键/空格/抓手 拖动 · Shift 多选 · 双击编辑
        </span>

        {/* 小地图 */}
        <Minimap nodes={doc.nodes} view={view} vp={vpSize} />

        {/* 底部悬浮生成条 */}
        <div className="absolute bottom-5 left-1/2 z-20 w-[min(760px,calc(100%-300px))] min-w-[420px] -translate-x-1/2">
          <div className="mb-2 flex items-center justify-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#121726]/90 px-3 py-1 text-[11px] text-mist-300 backdrop-blur">
              <span className={clsx('h-1.5 w-1.5 rounded-full', boundNode ? 'bg-brand-400' : 'bg-mist-400')} />
              {boundNode ? `已绑定：${boundNode.label}（生成结果会连到它右侧）` : '未绑定节点 · 结果放在画布中央'}
            </span>
            {boundNode && (
              <button onClick={() => setSelected([])} className="flex items-center gap-0.5 text-[11px] text-mist-400 hover:text-mist-200">
                解除 <X size={10} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-brand-400/30 bg-[#121726]/95 p-2 shadow-[0_0_0_1px_rgba(79,227,193,.08),0_20px_50px_-20px_rgba(0,0,0,.9),0_0_40px_-18px_rgba(79,227,193,.5)] backdrop-blur-xl">
            <button
              onClick={() => addNode('image')}
              title="添加图片节点"
              className="flex h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-[12.5px] text-mist-200 transition hover:bg-white/5 hover:text-white"
            >
              <ImagePlus size={16} /> 添加图片
            </button>
            <input
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
              placeholder="描述你想要生成的视频内容…（选中节点后编辑会同步到节点）"
              className="h-11 min-w-0 flex-1 rounded-xl border border-white/[0.06] bg-[#0d111c] px-3.5 text-[13px] text-mist-100 outline-none placeholder:text-mist-400/70 focus:border-brand-400/50"
            />
            <button
              onClick={() => aiRefine(singleSelected ? singleSelected.id : null)}
              disabled={aiBusy === 'prompt' || (singleSelected ? aiBusy === singleSelected.id : false)}
              title="AI 润色成视频提示词"
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-brand-400/30 px-3 text-[12.5px] text-brand-200 transition hover:bg-brand-400/10 hover:text-white disabled:opacity-40"
            >
              {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              AI 润色
            </button>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="h-11 cursor-pointer rounded-xl border border-white/[0.06] bg-[#0d111c] px-2 font-mono text-[12px] text-mist-200 outline-none"
              title="时长"
            >
              {[5, 8, 10].map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="h-11 cursor-pointer rounded-xl border border-white/[0.06] bg-[#0d111c] px-2 font-mono text-[12px] text-mist-200 outline-none"
              title="比例"
            >
              {['16:9', '9:16', '1:1'].map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <button
              onClick={generate}
              disabled={busy}
              className="mint-btn flex h-11 shrink-0 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              生成
            </button>
          </div>
        </div>

        {/* ---------------- 侧边 AI 助手 ---------------- */}
        {agentOpen && (
          <div className="absolute right-0 top-0 z-30 flex h-full w-[340px] flex-col border-l border-white/[0.08] bg-[#0b0f18]/95 backdrop-blur-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3.5 py-2.5">
              <span className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
                <Bot size={14} className="text-brand-300" /> AI 助手
              </span>
              <button onClick={() => setAgentOpen(false)} className="text-mist-400 transition hover:text-white">
                <X size={14} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
              {!msgs.length && (
                <div className="space-y-1 text-[11.5px] leading-relaxed text-mist-400">
                  <p className="text-mist-300">可以让我：</p>
                  <p>· 改写某条提示词</p>
                  <p>· 一次建多个镜头节点并连起来</p>
                  <p>· 直接把节点提交生成</p>
                  <p className="pt-1 text-[10.5px] text-mist-400/70">会读取当前画布的节点 id 和坐标。</p>
                </div>
              )}
              {msgs.map((m, i) => (
                <div
                  key={i}
                  className={clsx(
                    'whitespace-pre-wrap rounded-xl px-3 py-2 text-[12px] leading-relaxed',
                    m.role === 'user' ? 'bg-brand-400/10 text-mist-100' : 'bg-white/[0.04] text-mist-200'
                  )}
                >
                  {m.content}
                  {m.note && <div className="mt-1.5 text-[10.5px] text-brand-300">✓ {m.note}</div>}
                </div>
              ))}
              {agentBusy && (
                <div className="flex items-center gap-1.5 text-[11.5px] text-mist-400">
                  <Loader2 size={12} className="animate-spin" /> 思考中…
                </div>
              )}
              <div ref={msgEndRef} />
            </div>

            <div className="shrink-0 border-t border-white/[0.06] p-2.5">
              <textarea
                value={agentInput}
                onChange={(e) => setAgentInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgent(); } }}
                rows={2}
                placeholder="告诉我要做什么…（Shift+Enter 换行）"
                className="w-full resize-none rounded-xl border border-white/[0.08] bg-[#0d111c] px-3 py-2 text-[12px] text-mist-100 outline-none placeholder:text-mist-400/60 focus:border-brand-400/40"
              />
              <button
                onClick={sendAgent}
                disabled={agentBusy || !agentInput.trim()}
                className="mint-btn mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[12.5px] font-semibold disabled:opacity-40"
              >
                <Send size={13} /> 发送
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function pruneLinks(d) {
  const ids = new Set(d.nodes.map((n) => n.id));
  return { ...d, links: (d.links || []).filter((l) => ids.has(l.from) && ids.has(l.to)) };
}

function Sep() {
  return <span className="mx-1 h-5 w-px bg-white/[0.08]" />;
}

function ToolBtn({ icon: Icon, onClick, active, disabled, danger, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'grid h-9 w-9 place-items-center rounded-xl transition disabled:opacity-35',
        active ? 'bg-white/[0.08] text-white' : 'text-mist-300 hover:bg-white/5 hover:text-white',
        danger && 'hover:!text-rose-400'
      )}
    >
      <Icon size={16} />
    </button>
  );
}

function Minimap({ nodes, view, vp }) {
  const W = 176;
  const H = 116;
  if (!nodes.length) return null;
  const vx0 = -view.x / view.z;
  const vy0 = -view.y / view.z;
  const vw = vp.w / view.z;
  const vh = vp.h / view.z;
  const minX = Math.min(vx0, ...nodes.map((n) => n.x)) - 40;
  const minY = Math.min(vy0, ...nodes.map((n) => n.y)) - 40;
  const maxX = Math.max(vx0 + vw, ...nodes.map((n) => n.x + NODE_W)) + 40;
  const maxY = Math.max(vy0 + vh, ...nodes.map((n) => n.y + nodeH(n))) + 40;
  const k = Math.min(W / (maxX - minX), H / (maxY - minY));
  const tx = (x) => (x - minX) * k;
  const ty = (y) => (y - minY) * k;

  return (
    <div className="absolute bottom-5 right-5 z-20 hidden rounded-2xl border border-white/[0.07] bg-[#121726]/90 p-2.5 shadow-xl backdrop-blur md:block">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11.5px] text-mist-200">
          <MapIcon size={12} className="text-mist-400" /> 小地图
        </span>
        <Expand size={11} className="text-mist-400" />
      </div>
      <div className="dot-grid relative overflow-hidden rounded-xl" style={{ width: W, height: H, backgroundSize: '10px 10px' }}>
        {nodes.map((n) => (
          <span
            key={n.id}
            className="absolute rounded-[3px] border border-mist-300/40 bg-mist-300/25"
            style={{ left: tx(n.x), top: ty(n.y), width: Math.max(4, NODE_W * k), height: Math.max(3, nodeH(n) * k) }}
          />
        ))}
        <span
          className="absolute rounded-[4px] border border-brand-400/70 bg-brand-400/5"
          style={{ left: tx(vx0), top: ty(vy0), width: vw * k, height: vh * k }}
        />
      </div>
    </div>
  );
}

function CanvasNode({ node, active, onMouseDown, onPortDown, editing, aiBusy, onStartEdit, onTextChange, onEndEdit, onAi }) {
  const running = node.status === 'running';
  const failed = node.status === 'failed';
  const isText = node.type === 'text';
  const Icon = isText ? Type : node.type === 'image' ? ImageIcon : Video;
  const title = isText ? '文本提示词' : node.type === 'image' ? '图片' : '视频预览';
  const role = isText ? '输入' : '输出';
  const fileName = node.mediaUrl ? decodeURIComponent(node.mediaUrl.split('/').pop().split('?')[0]) : null;

  return (
    <div
      onMouseDown={onMouseDown}
      style={{ left: node.x, top: node.y, width: NODE_W }}
      className={clsx('glass-node absolute cursor-grab p-3.5 active:cursor-grabbing', active && 'is-active')}
    >
      {/* 连接点：左=输入，右=输出（拖出可连线） */}
      <span
        className={clsx(
          'absolute -left-[7px] top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 bg-[#0d111c]',
          active ? 'border-brand-400' : 'border-mist-400/60'
        )}
      />
      <span
        onMouseDown={onPortDown}
        title="拖拽到目标节点即可连线"
        className={clsx(
          'absolute -right-[7px] top-1/2 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 bg-[#0d111c] transition',
          'hover:scale-150 hover:border-brand-300 hover:bg-brand-400/40',
          active ? 'border-brand-400' : 'border-mist-400/60'
        )}
      />

      <div className="mb-2.5 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <Icon size={15} className="text-brand-400" />
          {title}
        </span>
        <span className="flex items-center gap-1.5">
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onAi}
            disabled={aiBusy}
            title="AI 润色提示词"
            className="grid h-5 w-5 place-items-center rounded-md text-brand-300/80 transition hover:bg-brand-400/15 hover:text-brand-200 disabled:opacity-40"
          >
            {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          </button>
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-mist-300">{role}</span>
        </span>
      </div>

      {isText ? (
        editing ? (
          <textarea
            autoFocus
            value={node.text || ''}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => onTextChange(e.target.value)}
            onBlur={onEndEdit}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onEndEdit(); } }}
            className="h-[92px] w-full resize-none rounded-xl border border-brand-400/40 bg-[#0d111c] px-3 py-2.5 text-[12px] leading-relaxed text-mist-100 outline-none"
          />
        ) : (
          <p
            onDoubleClick={onStartEdit}
            title="双击就地编辑"
            className="min-h-[76px] cursor-text whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-[#0d111c]/80 px-3 py-2.5 text-[12px] leading-relaxed text-mist-200 hover:border-brand-400/30"
          >
            {node.text || '双击编辑…'}
          </p>
        )
      ) : (
        <>
          <div className="relative overflow-hidden rounded-xl bg-black/40">
            {node.mediaUrl ? (
              node.type === 'video' ? (
                <video src={node.mediaUrl} muted loop playsInline autoPlay className="h-[128px] w-full object-cover" />
              ) : (
                <img src={node.mediaUrl} alt="" className="h-[128px] w-full object-cover" />
              )
            ) : (
              <div className="grid h-[128px] place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(15,169,138,.14),transparent_60%)]">
                {running ? (
                  <div className="flex items-center gap-1.5 text-[12px] text-brand-300">
                    <Loader2 size={14} className="animate-spin" /> {node.progress || 0}%
                  </div>
                ) : failed ? (
                  <span className="text-[11.5px] text-rose-400">生成失败</span>
                ) : (
                  <span className="text-[11.5px] text-mist-400">待生成</span>
                )}
              </div>
            )}
          </div>
          {editing && (
            <textarea
              autoFocus
              value={node.text || ''}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => onTextChange(e.target.value)}
              onBlur={onEndEdit}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onEndEdit(); } }}
              placeholder="这个镜头的提示词…"
              className="mt-2 h-[68px] w-full resize-none rounded-xl border border-brand-400/40 bg-[#0d111c] px-2.5 py-2 text-[11.5px] leading-relaxed text-mist-100 outline-none"
            />
          )}
        </>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px]">
        {isText ? (
          <span className="flex items-center gap-1.5 text-mist-400">
            <Sparkles size={12} /> muse-video
          </span>
        ) : (
          <>
            <span
              onDoubleClick={onStartEdit}
              title={node.text || '双击编辑提示词'}
              className="cursor-text truncate text-mist-200 hover:text-white"
            >{fileName || node.text || node.label}</span>
            <span className={clsx('flex shrink-0 items-center gap-1', failed ? 'text-rose-300' : running ? 'text-mist-300' : node.mediaUrl ? 'text-brand-300' : 'text-mist-400')}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', failed ? 'bg-rose-400' : running ? 'bg-amber-400' : node.mediaUrl ? 'bg-brand-400' : 'bg-mist-400')} />
              {failed ? '失败' : running ? '生成中' : node.mediaUrl ? '生成完成' : '空'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
