/**
 * 实装测试：模拟 DSH 运行时调用插件的 /htbh 命令（不依赖真实宿主）。
 * - 用桩 ctx 捕获命令处理器
 * - 端口指到 7791，避免和正在跑的 7788 撞车
 * - 依次执行 status → install → status，走真实安装器代码
 */
process.env.HALOFLUX_PORT = "7791";

let handler = null;
const ctx = {
  effect(fn) {
    try {
      fn();
    } catch (e) {
      console.error("effect error:", e);
    }
  },
  on() {},
  commands: {
    register(def) {
      handler = def.handler;
      console.log(`[注册命令] /${def.name} — ${def.description}`);
      return () => {};
    },
  },
};

const mod = await import("../lib/index.js");
mod.apply(ctx);

await new Promise((r) => setTimeout(r, 600));
if (!handler) {
  console.error("命令没有注册成功");
  process.exit(1);
}

async function run(sub) {
  const t0 = Date.now();
  const r = await handler({ rawInput: sub });
  const ms = Date.now() - t0;
  console.log(`\n===== /htbh ${sub}  (${ms} ms, ${r.kind}) =====`);
  console.log(r.text);
  return r;
}

await run("status");
await run("install");
await run("status");
process.exit(0);
