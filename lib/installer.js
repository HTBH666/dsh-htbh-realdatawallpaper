/**
 * 壁纸安装器：把插件自带的 assets 铺进 Lively Wallpaper，并绑定到当前显示器。
 *
 * 为什么是"复制 + 写 JSON"而不是用 Lively 的 URL 壁纸：
 *   Lively 的 URL 壁纸类型会做本地文件校验（"file ... not found"），
 *   本地网页壁纸则是稳定路径；壁纸页面再去连插件的 127.0.0.1 SSE 端口，
 *   127.0.0.1 属于 potentially trustworthy origin，https 页面也能连。
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export const WALLPAPER_ID = "htbh.realdata";

/** Lively 安装目录相关的路径 */
export function livelyPaths() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const localRoot = join(localAppData, "Lively Wallpaper");
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  return {
    localRoot,
    library: join(localRoot, "Library", "wallpapers"),
    layout: join(localRoot, "WallpaperLayout.json"),
    exe: join(programFiles, "Lively Wallpaper", "Lively.exe"),
  };
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function livelyInfo() {
  return {
    AppVersion: "2.2.1.0",
    Title: "HTBH 实时数据壁纸",
    Thumbnail: "thumbnail.jpg",
    Preview: "",
    Desc: "把 DSH 的 agent 运行事件投射成星际穿越风格圆环 + 大肥鱼桌面。由 dsh-htbh-realdatawallpaper 安装。",
    Author: "htbh",
    License: "MIT (code) / CC BY-NC-SA 4.0 (Live2D model)",
    Contact: "",
    Type: 1,
    FileName: "shell.html",
    Arguments: null,
    IsAbsolutePath: false,
  };
}

/** 复制素材到 Lively 壁纸库 */
async function copyAssets(assetsDir, targetDir) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  // 页面
  for (const f of ["shell.html", "circle.html", "haloflux-wallpaper.html", "live2d-inline.html", "live2d.html"]) {
    const src = join(assetsDir, f);
    if (await pathExists(src)) await cp(src, join(targetDir, f));
  }
  // 目录
  for (const d of ["live2d", "pet", "decrypt", "music"]) {
    const src = join(assetsDir, d);
    if (await pathExists(src)) await cp(src, join(targetDir, d), { recursive: true });
  }
  // 缩略图
  const thumb = join(assetsDir, "thumbnail.jpg");
  if (await pathExists(thumb)) await cp(thumb, join(targetDir, "thumbnail.jpg"));

  await writeFile(join(targetDir, "LivelyInfo.json"), JSON.stringify(livelyInfo(), null, 2), "utf8");
  return targetDir;
}

/** 把壁纸绑定到 Lively 的布局表（保留原有显示器信息，只替换壁纸路径） */
async function bindLayout(wallpaperDir) {
  const p = livelyPaths();
  let layout = [];
  if (await pathExists(p.layout)) {
    try {
      const raw = await readFile(p.layout, "utf8");
      layout = JSON.parse(raw.replace(/^\uFEFF/, ""));   // PowerShell 写出的 UTF8 可能带 BOM
      if (!Array.isArray(layout)) layout = [];
    } catch {
      layout = [];
    }
  }
  if (!layout.length) return { bound: 0, note: "布局表为空，请在 Lively 里双击新壁纸" };
  /* 注意：Lively 的 WallpaperLayout.json 里 LivelyInfoPath 存的是【壁纸目录】，
     不是 LivelyInfo.json 的文件路径 —— 写成文件路径会让它启动时报 "not found" 并放弃还原 */
  layout = layout.map((row) => ({ ...row, LivelyInfoPath: wallpaperDir }));
  await writeFile(p.layout, JSON.stringify(layout, null, 2), "utf8");
  return { bound: layout.length, note: "" };
}

/** 启动 Lively（已在跑就跳过）。用 detached 让它脱离 DSH 进程树。 */
export async function startLively() {
  const p = livelyPaths();
  if (!(await pathExists(p.exe))) return { started: false, reason: "没有找到 Lively.exe" };
  const running = await new Promise((resolve) => {
    const ps = spawn("tasklist", ["/FI", "IMAGENAME eq Lively.exe", "/NH"], { windowsHide: true });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => resolve(/Lively\.exe/i.test(out)));
    ps.on("error", () => resolve(false));
  });
  if (running) return { started: false, reason: "Lively 已在运行" };
  const child = spawn(p.exe, [], { detached: true, stdio: "ignore" });
  child.unref();
  return { started: true, reason: "" };
}

export async function installWallpaper(assetsDir) {
  const p = livelyPaths();
  if (!(await pathExists(p.localRoot))) {
    throw new Error(`没有找到 Lively Wallpaper（${p.localRoot}）。请先安装 Lively Wallpaper。`);
  }
  if (!(await pathExists(assetsDir))) {
    throw new Error(`插件素材目录不存在：${assetsDir}`);
  }
  const targetDir = join(p.library, WALLPAPER_ID);
  await copyAssets(assetsDir, targetDir);
  const infoPath = join(targetDir, "LivelyInfo.json");
  const { bound, note } = await bindLayout(targetDir);
  const started = await startLively();
  return { targetDir, infoPath, bound, note, started };
}

export async function uninstallWallpaper() {
  const p = livelyPaths();
  const targetDir = join(p.library, WALLPAPER_ID);
  const existed = await pathExists(targetDir);
  await rm(targetDir, { recursive: true, force: true });
  // 布局表里若还引用它，指向一个不存在的路径会导致 Lively 跳过整行，直接清空引用
  if (await pathExists(p.layout)) {
    try {
      let layout = JSON.parse((await readFile(p.layout, "utf8")).replace(/^\uFEFF/, ""));
      if (Array.isArray(layout)) {
        layout = layout.filter((row) => !String(row.LivelyInfoPath || "").includes(WALLPAPER_ID));
        await writeFile(p.layout, JSON.stringify(layout, null, 2), "utf8");
      }
    } catch {
      /* 布局表坏了就不动它 */
    }
  }
  return { removed: existed, targetDir };
}

export async function wallpaperStatus(assetsDir) {
  const p = livelyPaths();
  const targetDir = join(p.library, WALLPAPER_ID);
  const installed = await pathExists(join(targetDir, "LivelyInfo.json"));
  const size = installed
    ? (await import("node:fs")).statSync(join(targetDir, "shell.html")).size
    : 0;
  return {
    livelyFound: await pathExists(p.localRoot),
    installed,
    targetDir,
    shellBytes: size,
    assetsDir,
  };
}
