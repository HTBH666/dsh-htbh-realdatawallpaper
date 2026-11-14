/**
 * 冒烟测试：只验证 HTTP 层（不依赖 DSH 运行时）。
 * 用桩 ctx 调 apply()，把端口指到 7799 避免和正在跑的 7788 冲突。
 */
process.env.HALOFLUX_PORT = "7799";

const ctx = {
  effect(fn) {
    try {
      fn();
    } catch (e) {
      console.error("effect error", e);
    }
  },
  on() {},
  commands: { register: () => () => {} },
};

const bridge = await import("../lib/bridge.js");
bridge.apply(ctx);

await new Promise((r) => setTimeout(r, 800));

const base = "http://127.0.0.1:7799";
async function check(label, url, opts) {
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get("content-type") || "";
    let body = "";
    if (ct.includes("json")) body = await res.text();
    else body = `<${(await res.arrayBuffer()).byteLength} bytes>`;
    console.log(`${label.padEnd(26)} ${res.status} ${ct.slice(0, 28).padEnd(28)} ${String(body).slice(0, 90)}`);
    return res;
  } catch (e) {
    console.log(`${label.padEnd(26)} ERROR ${e.message}`);
  }
}

await check("GET /music/list", `${base}/music/list`);

const listRes = await fetch(`${base}/music/list`);
const list = await listRes.json();
console.log("曲目:", list.files.map((f) => f.name).join(", ") || "(空)");

for (const f of list.files) {
  await check(`GET /music/${f.name}`.slice(0, 26), `${base}/music/${encodeURIComponent(f.name)}`, {
    headers: { range: "bytes=0-99" },
  });
}

await check("GET /haloflux/stream (HEAD)", `${base}/haloflux/stream`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
process.exit(0);
