/**
 * dsh-htbh-realdatawallpaper — 实时数据壁纸插件
 *
 * 两件事：
 *   1) 复用 halofluX 的宿主桥（lib/bridge.js）：只读订阅 session/event，
 *      在本地 127.0.0.1:<port> 起 SSE，把 agent 的真实运行投射给壁纸页面。
 *      —— 壁纸只认真实事件流，没有任何模拟数据。
 *   2) 注册 /htbh 命令：把插件自带的素材一键装进 Lively Wallpaper 并绑定显示器。
 *
 * 素材：assets/ 下是完整的双页壁纸（圆环 + 大肥鱼 + Live2D + 立绘视频）。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apply as startBridge } from "./bridge.js";
import { installWallpaper, uninstallWallpaper, wallpaperStatus, livelyPaths } from "./installer.js";

export const name = "htbh-realdatawallpaper";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(HERE, "..", "assets");

const USAGE = [
  "用法：",
  "  /htbh install    把壁纸装进 Lively 并设为当前壁纸",
  "  /htbh status     查看安装状态与路径",
  "  /htbh uninstall  从 Lively 移除本壁纸",
].join("\n");

function ok(text) {
  return { kind: "success", text };
}

function fail(text) {
  return { kind: "error", text };
}

async function handleCommand(raw) {
  const sub = String(raw || "").trim().toLowerCase().split(/\s+/)[0] || "status";

  try {
    if (sub === "install") {
      const r = await installWallpaper(ASSETS_DIR);
      const lines = [
        "壁纸已安装 ✅",
        `目录：${r.targetDir}`,
        r.bound > 0 ? `已绑定 ${r.bound} 个显示器` : r.note,
        r.started.started ? "已启动 Lively Wallpaper" : `Lively：${r.started.reason}`,
        "",
        "如果桌面没有立刻变化：打开 Lively → 找到「HTBH 实时数据壁纸」双击一次。",
        "壁纸数据来自本插件的 127.0.0.1:7788 事件流，请保持 DSH 运行。",
      ];
      return ok(lines.join("\n"));
    }

    if (sub === "uninstall") {
      const r = await uninstallWallpaper();
      return ok(
        [
          r.removed ? "已从 Lively 移除本壁纸" : "没有找到已安装的壁纸（无需移除）",
          `目录：${r.targetDir}`,
          "提示：Lively 里可能还留着缩略图缓存，重启 Lively 后消失。",
        ].join("\n"),
      );
    }

    if (sub === "status") {
      const s = await wallpaperStatus(ASSETS_DIR);
      const p = livelyPaths();
      return ok(
        [
          `Lively：${s.livelyFound ? "已安装" : "未找到"}`,
          `壁纸：${s.installed ? "已安装" : "未安装"}`,
          `安装目录：${s.targetDir}`,
          `素材目录：${s.assetsDir}`,
          `Lively 程序：${p.exe}`,
          "",
          s.installed ? "要重新安装：/htbh install" : "要安装：/htbh install",
        ].join("\n"),
      );
    }

    return fail(`未知子命令：${sub}\n\n${USAGE}`);
  } catch (err) {
    return fail(`执行失败：${err && err.message ? err.message : String(err)}`);
  }
}

export function apply(ctx) {
  // 1) 真实事件流（SSE + 静态资源），端口默认 7788，可用 HALOFLUX_PORT 覆盖
  startBridge(ctx);

  // 2) /htbh 命令 —— 必须等 commands 服务就绪再注册（插件可能先于服务加载）
  const registerCommand = (cctx) =>
    cctx.effect(
      () =>
        cctx.commands.register({
          name: "htbh",
          description: "安装/卸载 HTBH 实时数据壁纸到 Lively Wallpaper",
          input: { hint: "install | status | uninstall" },
          handler: (invocation) => handleCommand(invocation && invocation.rawInput),
        }),
      "htbh-realdatawallpaper: /htbh command",
    );

  if (typeof ctx.inject === "function") {
    ctx.inject(["commands"], (cctx) => registerCommand(cctx));
  } else {
    registerCommand(ctx);
  }
}
