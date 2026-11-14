/**
 * 会话日志监听器
 *
 * dsh 把会话事件追加写入 ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
 * （多帧 zstd，每帧一段 JSONL）。
 *
 * 插件运行在 web 宿主里，而用户可能在桌面端使用 agent —— 那时 session/event
 * 不会经过本进程。直接读日志文件可以覆盖两个宿主，不需要重启任何东西。
 *
 * 只读、不修改任何文件。
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const POLL_MS = 350;
const MAX_FILES = 3; // 同时跟踪最近 3 个会话文件

/** 递归找所有 session.v4.jsonl.zstd（只下探 3 层，够用） */
async function findLogs(root) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name === "session.v4.jsonl.zstd") {
        try {
          const st = await stat(p);
          out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root, 0);
  return out;
}

/** 把缓冲区里所有完整的 zstd 帧解出来；返回 [解压文本, 已消费字节数] */
function decodeFrames(buf) {
  const positions = [];
  let idx = buf.indexOf(ZSTD_MAGIC);
  while (idx !== -1) {
    positions.push(idx);
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4);
  }
  if (positions.length === 0) {
    // 没有魔数：整段丢弃，避免无限堆积
    return ["", buf.length];
  }
  let text = "";
  let consumed = positions[0] === 0 ? 0 : 0;
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(start, end));
      text += out.toString("utf8");
      consumed = end; // 这一帧完整
    } catch {
      // 最后一帧还没写完：保留，下次再解
      break;
    }
  }
  return [text, consumed];
}

export function startLogWatch(onEvent, opts = {}) {
  const root = opts.root || join(homedir(), ".dsh", "sessions");
  const state = new Map(); // path -> { offset, size, pending: Buffer, primed }
  const seen = new Set(); // "path:seq" 去重
  let timer = null;
  let stopped = false;

  async function pollOnce() {
    const logs = await findLogs(root);
    if (logs.length === 0) return;
    logs.sort((a, b) => b.mtime - a.mtime);
    const active = logs.slice(0, MAX_FILES);

    for (const info of active) {
      const prev = state.get(info.path);
      if (!prev) {
        // 首次见到这个文件：定位到末尾，只处理之后新增的事件，
        // 避免把整段历史灌进来（会让画面疯狂闪）
        state.set(info.path, { offset: info.size, pending: Buffer.alloc(0) });
        continue;
      }
      if (info.size <= prev.offset) continue;

      // 首次见到：从头解码最近的 1 帧就够（避免一次灌入全部历史）
      let readFrom = prev ? prev.offset : 0;
      let len = info.size - readFrom;
      if (len <= 0) continue;
      if (len > 8 * 1024 * 1024) {
        // 极端情况：跳过太老的积压，避免卡住
        readFrom = info.size - 512 * 1024;
        len = info.size - readFrom;
      }

      let buf;
      try {
        const fh = await open(info.path, "r");
        buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, readFrom);
        await fh.close();
      } catch {
        continue;
      }

      const rec = prev || { offset: readFrom, pending: Buffer.alloc(0), primed: false };
      const merged = Buffer.concat([rec.pending, buf]);
      const [text, consumed] = decodeFrames(merged);

      rec.pending = merged.subarray(consumed);
      rec.offset = readFrom + consumed;
      state.set(info.path, rec);

      if (!text) continue;

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (!ev || typeof ev.type !== "string") continue;
        // 跳过会话头
        if (ev.type === "session") continue;
        const key = info.path + ":" + (ev.seq ?? "") + ":" + ev.type;
        if (ev.seq !== undefined) {
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > 4000) seen.clear();
        }
        try {
          onEvent(ev, info.path);
        } catch {
          /* 单个事件失败不影响后续 */
        }
      }
    }
  }

  async function loop() {
    if (stopped) return;
    try {
      await pollOnce();
    } catch {
      /* 忽略整轮错误 */
    }
    if (!stopped) {
      timer = setTimeout(loop, POLL_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  loop();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
