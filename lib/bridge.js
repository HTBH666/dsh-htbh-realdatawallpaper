/**
 * dsh-haloflux-live — 宿主平面插件
 *
 * 职责：只读订阅 dsh 的 `session/event`，把 agent 的真实运行投影成
 * 一组音乐引擎认识的事件，经本地 HTTP/SSE 端口推给浏览器端演奏器。
 *
 * 设计要点
 * - 独立端口（默认 7788）：dsh web 自带浏览器认证栅栏，外部演奏页面
 *   （或壁纸）取用会撞 401；自带端口 + 显式 CORS 更简单可控。
 * - 不注册模型工具、不写会话事件 —— 纯观察者。
 * - delta 级事件按 60ms 窗口聚合，避免 token 洪峰把 SSE 和渲染都打爆。
 * - 事件结构做防御式提取：dsh 的事件 payload 字段名在不同版本可能微调，
 *   取不到就降级，不抛错。
 */

import http from "node:http";

export const name = "haloflux-live";

const PORT = Number(process.env.HALOFLUX_PORT || 7788);
const FLUSH_MS = 60;
const DEBUG = process.env.HALOFLUX_DEBUG === "1";

/** 已连接的 SSE 客户端 */
const clients = new Set();
const rawClients = new Set();
let seq = 0;

/* ---------------- 聚合缓冲 ---------------- */
const pending = {
  reasoningLen: 0,
  textLen: 0,
  toolDeltas: 0,
  textBuf: "",
  flushTimer: null,
};

/* ---------------- 英文单词抽取（供女声演唱） ---------------- */
const WORD_STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "will",
  "you", "are", "not", "but", "can", "all", "any", "was", "were", "they",
  "them", "then", "than", "there", "here", "what", "when", "where", "which",
  "how", "why", "who", "use", "used", "using", "let", "get", "got", "set",
]);
let lastWordAt = 0;
const WORD_MIN_GAP_MS = 2600;

function extractWord(buf) {
  const re = /[A-Za-z]{3,14}/g;
  let cand = null;
  let m;
  while ((m = re.exec(buf)) !== null) {
    const w = m[0];
    if (WORD_STOP.has(w.toLowerCase())) continue;
    if (/^[0-9a-f]{6,}$/i.test(w)) continue;      // 跳过哈希/十六进制
    if (/(.)\1{3,}/.test(w)) continue;            // 跳过 aaaa 这类
    cand = w;
    if (w.length >= 5 && w.length <= 10) break;   // 偏好中等长度，读起来更顺
  }
  return cand;
}

function frame(ev) {
  seq += 1;
  return `id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function broadcast(ev) {
  if (!clients.size) return;
  const payload = frame(ev);
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** 立即发送非聚合类事件 */
function send(ev) {
  flushAggregates();
  broadcast(ev);
}

/** 把累积的 delta 长度合并成一条事件 */
function flushAggregates() {
  if (pending.reasoningLen > 0) {
    broadcast({ type: "reasoning/delta", len: pending.reasoningLen });
    pending.reasoningLen = 0;
  }
  if (pending.textLen > 0) {
    broadcast({ type: "text/delta", len: pending.textLen });
    pending.textLen = 0;
  }
  if (pending.toolDeltas > 0) {
    broadcast({ type: "tool/delta", len: pending.toolDeltas });
    pending.toolDeltas = 0;
  }
  // 从文本缓冲里挑一个英文词，限速送给演奏端
  if (pending.textBuf.length > 0) {
    const now = Date.now();
    if (now - lastWordAt > WORD_MIN_GAP_MS) {
      const w = extractWord(pending.textBuf);
      if (w) {
        lastWordAt = now;
        broadcast({ type: "vocal/word", w });
      }
    }
    if (pending.textBuf.length > 600) pending.textBuf = pending.textBuf.slice(-400);
  }
}

function scheduleFlush() {
  if (pending.flushTimer) return;
  pending.flushTimer = setTimeout(() => {
    pending.flushTimer = null;
    flushAggregates();
  }, FLUSH_MS);
  if (typeof pending.flushTimer.unref === "function") pending.flushTimer.unref();
}

/* ---------------- 事件 schema 采集：用真实流量校对映射，杜绝推断 ---------------- */
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { startLogWatch } from "./logwatch.js";
import { homedir } from "node:os";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = join(homedir(), ".dsh", "haloflux-schema.json");
const PET_ROOT = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-pet-live2d");
const PET_CORE_ROOT = join(homedir(), ".dsh", "pets", ".runtime");
// 插件自带的示例音乐（安装后由 /music/* 提供，壁纸里点一下就播）
const MUSIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "music");
const PET_MIME = {
  ".moc3": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".js": "text/javascript; charset=utf-8",
  ".motion3": "application/json; charset=utf-8",
};
const WALLPAPER_PATH =
  process.env["HALOFLUX_WALLPAPER"] ||
  join(homedir(), "AppData", "Local", "Lively Wallpaper", "Library", "wallpapers", "htbh.realdata", "shell.html");
const schema = { capturedAt: null, events: {}, unknownTypes: [] };

function describeValue(v, depth) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    return v.length ? [`array(${v.length})`, describeValue(v[0], (depth || 0) + 1)] : "array(0)";
  }
  const t = typeof v;
  if (t === "object") {
    if ((depth || 0) > 2) return "object…";
    const out = {};
    for (const k of Object.keys(v).slice(0, 20)) out[k] = describeValue(v[k], (depth || 0) + 1);
    return out;
  }
  if (t === "string") return v.length > 40 ? `string(${v.length})` : `string:${v}`;
  return t;
}

function captureSchema(event) {
  if (!event || typeof event.type !== "string") return;
  const d = dataOf(event);
  const prev = schema.events[event.type];
  if (prev) {
    prev.count += 1;
    prev.lastSeq = event.seq;
    // 同一类型出现新字段时也记下来
    for (const k of Object.keys(d)) if (!(k in prev.keys)) prev.keys[k] = describeValue(d[k]);
    return;
  }
  const keys = {};
  for (const k of Object.keys(d)) keys[k] = describeValue(d[k]);
  schema.events[event.type] = {
    count: 1,
    firstSeq: event.seq,
    lastSeq: event.seq,
    keys,
  };
  schema.capturedAt = new Date().toISOString();
  persistSchema();
}

let schemaTimer = null;
function persistSchema() {
  if (schemaTimer) return;
  schemaTimer = setTimeout(() => {
    schemaTimer = null;
    try {
      writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2), "utf8");
    } catch {
      /* 忽略写盘失败 */
    }
  }, 500);
  if (typeof schemaTimer.unref === "function") schemaTimer.unref();
}

/* ---------------- 防御式取值 ---------------- */
function dataOf(event) {
  const d = event && event.data;
  return d && typeof d === "object" ? d : {};
}

function textOfChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.argumentsDelta === "string") return chunk.argumentsDelta;
  return "";
}

/* ---------------- 真实数据：工具参数 / 错误 / 状态表 ---------------- */
const toolCalls = new Map();     // callId -> { name, at, args }
const subagents = new Map();     // agentId -> { id, name, role, task }
const teamMembers = new Map();   // memberId -> { id, name, role, state }

function shortStr(v, n) {
  if (typeof v !== "string") {
    try {
      v = JSON.stringify(v);
    } catch {
      return "";
    }
  }
  if (typeof v !== "string") return "";
  v = v.replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

/** 从 tool/call 的 arguments 里摘出最有信息量的片段用于画面展示 */
function argsPreviewOf(d) {
  const raw = d.arguments ?? d.args ?? d.input;
  if (raw === undefined || raw === null) return "";
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return shortStr(raw, 110);
    }
  }
  if (obj && typeof obj === "object") {
    // 优先展示最能说明"在干什么"的字段
    for (const k of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "text", "prompt", "description"]) {
      if (typeof obj[k] === "string" && obj[k]) return shortStr(obj[k], 110);
    }
    const first = Object.keys(obj)[0];
    if (first !== undefined) return shortStr(first + "=" + shortStr(obj[first], 80), 110);
  }
  return shortStr(obj, 110);
}

/** 从 tool/result 里摘出错误文本 */
function errTextOf(d, msg) {
  if (d.error) {
    if (typeof d.error === "string") return shortStr(d.error, 120);
    if (typeof d.error.message === "string") return shortStr(d.error.message, 120);
  }
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string" && /error|失败|错误/i.test(c.text)) {
      return shortStr(c.text, 120);
    }
  }
  return "error";
}

function toolNameOf(d) {
  return (
    (typeof d.name === "string" && d.name) ||
    (typeof d.toolName === "string" && d.toolName) ||
    (typeof d.tool === "string" && d.tool) ||
    ""
  );
}

/** 从消息事件里尽力取出纯文本（结构随版本可能不同，逐层降级）。 */
function textOfMessage(d) {
  const msg = d.message ?? d;
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const parts = [];
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  if (!parts.length && typeof msg.text === "string") parts.push(msg.text);
  return parts.join("\n");
}

/** FNV-1a 32 位：同一段文本永远同一首歌的种子。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ---------------- 调试：打印没见过的事件形状 ---------------- */
const seenTypes = new Set();
function debugShape(event) {
  if (!DEBUG) return;
  const t = event && event.type;
  if (!t || seenTypes.has(t)) return;
  seenTypes.add(t);
  const keys = Object.keys(dataOf(event)).join(",");
  process.stderr.write(`[haloflux-live] event ${t} data-keys=(${keys})\n`);
}

/* ---------------- 核心映射：dsh 事件 → 演奏事件 ---------------- */
function project(event) {
  if (!event || typeof event.type !== "string") return;
  debugShape(event);
  captureSchema(event);
  if (rawClients.size) {
    const d = dataOf(event);
    const brief = { type: 'raw', t: event.type, seq: event.seq };
    for (const k of ['turn', 'step', 'name', 'toolName', 'ok', 'outcome', 'policy', 'reason']) {
      if (d[k] !== undefined) brief[k] = typeof d[k] === 'object' ? JSON.stringify(d[k]).slice(0, 60) : d[k];
    }
    brief.keys = Object.keys(d);
    const payload = "event: raw`ndata: " + JSON.stringify(brief) + "`n`n";
    for (const res of rawClients) { try { res.write(payload); } catch { rawClients.delete(res); } }
  }
  const d = dataOf(event);

  switch (event.type) {
    /* ---- 用户指令：派生「这首歌」的身份种子 ---- */
    case "user/message": {
      const text = textOfMessage(d);
      const h = fnv1a(text);
      // chars 仅用于面板显示，避免把正文外泄到播放端
      send({ type: "task/seed", seed: h, chars: text.length });
      return;
    }

    case "turn/start":
      send({ type: "turn/start" });
      return;

    case "turn/end":
      send({ type: "turn/end", reason: d.reason ?? d.outcome ?? null });
      return;

    case "step/start":
      send({ type: "step/start" });
      return;

    /* ---- 关键：token 级增量 ---- */
    case "assistant/chunk": {
      const chunk = d.chunk || {};
      const text = textOfChunk(chunk);
      const n = text.length || 1;
      switch (chunk.type) {
        case "reasoning-delta":
          pending.reasoningLen += n;
          pending.textBuf += text;
          scheduleFlush();
          return;
        case "text-delta":
          pending.textLen += n;
          pending.textBuf += text;
          scheduleFlush();
          return;
        case "tool-call-delta":
          pending.toolDeltas += n;
          pending.textBuf += text;   // 参数里常有英文标识符
          scheduleFlush();
          return;
        default:
          // block-start / block-end / usage / finish 不进音乐，但可用于段落边界
          if (chunk.type === "block-end") send({ type: "block/end" });
          return;
      }
    }

    /* ---- 工具（带真实参数，供画面显示）---- */
    case "tool/call": {
      const args = argsPreviewOf(d);
      toolCalls.set(String(d.callId ?? ""), { name: toolNameOf(d) || "tool", at: Date.now(), args });
      send({
        type: "tool/call",
        name: toolNameOf(d) || "tool",
        args,
        turn: d.turn,
        step: d.step,
      });
      return;
    }

    case "tool/result": {
      const msg = d.message || {};
      const isError = msg.isError === true || d.error !== undefined;
      const callId = String((msg.source && msg.source.callId) ?? "");
      const prev = toolCalls.get(callId);
      if (prev) toolCalls.delete(callId);
      send({
        type: "tool/result",
        ok: !isError,
        name: (prev && prev.name) || toolNameOf(d) || "",
        ms: prev ? Date.now() - prev.at : 0,
        err: isError ? errTextOf(d, msg) : "",
        turn: d.turn,
        step: d.step,
      });
      return;
    }

    /* ---- 审批 ---- */
    case "approval/asked":
      send({ type: "approval/asked", name: toolNameOf(d) });
      return;

    case "approval/decided":
      send({ type: "approval/decided", outcome: d.outcome ?? null });
      return;

    /* ---- 重试 ---- */
    case "llm/retry":
    case "llm/retry-started":
      send({ type: "retry" });
      return;

    /* ---- 压缩 ---- */
    case "compaction/start":
    case "compaction/end":
    case "compaction/summary":
    case "compaction/prune":
      send({ type: "compaction", phase: event.type.split("/")[1] });
      return;

    /* ---- 子代理：真实 roster ---- */
    case "subagent/descriptor": {
      const id = String(d.id ?? d.agentId ?? d.name ?? "");
      if (!id) return;
      subagents.set(id, {
        id,
        name: String(d.name ?? d.title ?? id),
        role: String(d.role ?? d.kind ?? d.model ?? ""),
        task: String(d.description ?? d.task ?? "").slice(0, 80),
      });
      send({ type: "subagent/roster", list: [...subagents.values()] });
      return;
    }

    case "subagent/catalog": {
      const list = Array.isArray(d.agents) ? d.agents : Array.isArray(d.catalog) ? d.catalog : [];
      for (const a of list) {
        const id = String((a && (a.id ?? a.agentId ?? a.name)) ?? "");
        if (!id) continue;
        subagents.set(id, {
          id,
          name: String(a.name ?? a.title ?? id),
          role: String(a.role ?? a.kind ?? ""),
          task: String(a.description ?? "").slice(0, 80),
        });
      }
      send({ type: "subagent/roster", list: [...subagents.values()] });
      return;
    }

    case "tool-workflow/agent-start":
    case "subagent/agent-start": {
      const id = String(d.agentId ?? d.id ?? d.name ?? "sub");
      send({ type: "subagent/start", id });
      return;
    }

    case "tool-workflow/agent-end":
    case "subagent/agent-end": {
      const id = String(d.agentId ?? d.id ?? d.name ?? "sub");
      send({ type: "subagent/end", id });
      return;
    }

    /* ---- 团队 ---- */
    case "team/member": {
      const id = String(d.id ?? d.name ?? "");
      if (id) {
        teamMembers.set(id, {
          id,
          name: String(d.name ?? id),
          role: String(d.role ?? ""),
          state: String(d.state ?? d.status ?? ""),
        });
        send({ type: "team/members", list: [...teamMembers.values()] });
      }
      return;
    }

    case "team/task": {
      send({
        type: "team/task",
        id: String(d.id ?? ""),
        state: String(d.state ?? d.status ?? ""),
        title: String(d.title ?? d.subject ?? "").slice(0, 80),
      });
      return;
    }

    /* ---- TODO：真实任务清单 ---- */
    case "todo/write": {
      const items = Array.isArray(d.todos) ? d.todos : Array.isArray(d.items) ? d.items : [];
      send({
        type: "todo",
        total: items.length,
        done: items.filter((t) => t && (t.status === "completed" || t.completed === true)).length,
        items: items.slice(0, 12).map((t) => ({
          c: String((t && (t.content ?? t.text)) ?? "").slice(0, 60),
          s: String((t && t.status) ?? ""),
        })),
      });
      return;
    }

    /* ---- 工作区改动 ---- */
    case "workspace/changes": {
      const files = Array.isArray(d.files)
        ? d.files
        : Array.isArray(d.changes)
          ? d.changes
          : [];
      send({
        type: "workspace",
        count: files.length,
        files: files.slice(0, 12).map((f) => ({
          p: String((f && (f.path ?? f.file)) ?? f ?? "").slice(0, 70),
          k: String((f && (f.kind ?? f.status)) ?? ""),
        })),
      });
      return;
    }

    default:
      return;
  }
}

/* ---------------- HTTP / SSE ---------------- */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,OPTIONS",
  "cache-control": "no-store",
};

function handle(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (url.pathname === "/haloflux/stream") {
    res.writeHead(200, {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": halofluX-live bridge connected\n\n");
    clients.add(res);
    const ka = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(ka);
        clients.delete(res);
      }
    }, 15000);
    if (typeof ka.unref === "function") ka.unref();
    req.on("close", () => {
      clearInterval(ka);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === "/haloflux/raw") {
    res.writeHead(200, {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": halofluX raw channel\n\n");
    rawClients.add(res);
    const ka = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(ka); rawClients.delete(res); } }, 15000);
    if (typeof ka.unref === "function") ka.unref();
    req.on("close", () => { clearInterval(ka); rawClients.delete(res); });
    return;
  }
  if (url.pathname.startsWith("/pet-core/")) {
    const rel = decodeURIComponent(url.pathname.slice(10));
    if (rel.includes("..")) {
      res.writeHead(403, CORS);
      res.end("forbidden");
      return;
    }
    try {
      const data = readFileSync(join(PET_CORE_ROOT, rel));
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "max-age=600",
        ...CORS,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...CORS });
      res.end("core asset not found: " + rel);
    }
    return;
  }

  if (url.pathname === "/music/list") {
    try {
      const files = readdirSync(MUSIC_DIR)
        .filter((f) => /\.(mp3|m4a|ogg|flac|wav|opus|webm)$/i.test(f))
        .map((name) => ({ name }));
      res.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ files }));
    } catch {
      res.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ files: [] }));
    }
    return;
  }

  if (url.pathname.startsWith("/music/")) {
    const rel = decodeURIComponent(url.pathname.slice(7));
    if (rel.includes("..") || rel.startsWith("/")) {
      res.writeHead(403, CORS);
      res.end("forbidden");
      return;
    }
    const full = join(MUSIC_DIR, rel);
    const ext = (rel.split(".").pop() || "").toLowerCase();
    const mime = { mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg",
                   flac: "audio/flac", wav: "audio/wav", webm: "audio/webm" }[ext] || "application/octet-stream";
    try {
      const size = statSync(full).size;
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        res.writeHead(206, {
          ...CORS,
          "content-type": mime,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-length": end - start + 1,
        });
        createReadStream(full, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...CORS, "content-type": mime, "accept-ranges": "bytes", "content-length": size });
        createReadStream(full).pipe(res);
      }
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...CORS });
      res.end("not found: " + rel);
    }
    return;
  }

  if (url.pathname.startsWith("/pet/")) {
    const rel = decodeURIComponent(url.pathname.slice(5));
    if (rel.includes("..") || rel.startsWith("/")) {
      res.writeHead(403, CORS);
      res.end("forbidden");
      return;
    }
    const full = join(PET_ROOT, rel);
    try {
      const data = readFileSync(full);
      const ext = extname(full).toLowerCase();
      res.writeHead(200, {
        "content-type": PET_MIME[ext] || "application/octet-stream",
        "cache-control": "max-age=600",
        ...CORS,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...CORS });
      res.end("pet asset not found: " + rel);
    }
    return;
  }

  if (url.pathname === "/wallpaper" || url.pathname === "/wallpaper/") {
    try {
      const html = readFileSync(WALLPAPER_PATH, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
    } catch (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...CORS });
      res.end("wallpaper not found\n" + WALLPAPER_PATH + "\n" + (err && err.message));
    }
    return;
  }
  if (url.pathname === "/haloflux/schema") {
    res.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ path: SCHEMA_PATH, ...schema }));
    return;
  }
  if (url.pathname === "/haloflux/state") {
    res.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        port: PORT,
        seq,
        clients: clients.size,
        pending: {
          reasoningLen: pending.reasoningLen,
          textLen: pending.textLen,
          toolDeltas: pending.toolDeltas,
        },
        seenEventTypes: [...seenTypes],
      }),
    );
    return;
  }

  res.writeHead(404, { ...CORS, "content-type": "text/plain; charset=utf-8" });
  res.end("haloflux-live: try /haloflux/stream or /haloflux/state\n");
}

/* ---------------- 插件入口 ---------------- */
export function apply(ctx) {
  let server = null;

  ctx.effect(() => {
    let closedA = false;
    let retryTimer = null;
    const tryListen = () => {
      if (closedA) return;
      server = http.createServer(handle);
      server.on("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
          /* 端口被占（旧桥插件还在跑 / 宿主未重启）：3 秒后重试，不因此让插件失败 */
          process.stderr.write(`[htbh] 端口 ${PORT} 被占用，3 秒后重试\n`);
          retryTimer = setTimeout(tryListen, 3000);
          if (typeof retryTimer.unref === "function") retryTimer.unref();
          return;
        }
        process.stderr.write(`[htbh] http error: ${err.message}\n`);
      });
      server.listen(PORT, "127.0.0.1", () => {
        process.stderr.write(`[htbh] listening on http://127.0.0.1:${PORT}/haloflux/stream\n`);
      });
    };
    tryListen();
    return () => {
      closedA = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        if (server) server.close();
      } catch {
        /* ignore */
      }
      server = null;
      clients.clear();
    };
  }, "haloflux-live: local sse bridge");

  // 会话日志监听：覆盖"agent 跑在别的宿主（桌面端）"的情况
  ctx.effect(() => {
    const stop = startLogWatch((event) => {
      try {
        project(event);
      } catch (err) {
        if (DEBUG) process.stderr.write(`[haloflux-live] logwatch project error: ${err && err.message}\n`);
      }
    });
    return stop;
  }, "haloflux-live: session log watcher");

  ctx.on("session/event", (_session, event) => {
    try {
      project(event);
    } catch (err) {
      if (DEBUG) {
        process.stderr.write(`[haloflux-live] project error: ${err && err.message}\n`);
      }
    }
  });

  // 实时 token 流：dsh 把流式帧发在 agent/assistant-stream 上，
  // 而不是作为 session/event 的 assistant/chunk 事件（后者只在日志重放时合成）。
  // 帧形状：{ type: "start" | "chunk" | "end", chunk?: StreamChunk }
  ctx.on("agent/assistant-stream", ({ agent, frame } = {}) => {
    try {
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "chunk" && frame.chunk) {
        project({
          type: "assistant/chunk",
          data: { chunk: frame.chunk, sessionId: agent && agent.session && agent.session.id },
          seq: 0,
          time: Date.now(),
        });
      } else if (frame.type === "end") {
        send({ type: "stream/end" });
      }
    } catch (err) {
      if (DEBUG) {
        process.stderr.write(`[haloflux-live] stream frame error: ${err && err.message}\n`);
      }
    }
  });
}
