# dsh-htbh-realdatawallpaper

**把你和 agent 一起工作的过程，变成桌面壁纸。**

一个 [DeepSeek Harness](https://github.com/) 插件。装上之后，它把 DSH 的 **agent 真实运行事件**（工具调用、思考、子代理、团队任务……）实时投射成一张《星际穿越》风格的动态壁纸：

- **圆环页** — 米勒星球的环，工具调用会从环上射出光柱、凝成光点，被中心的黑洞吞进去；调用的工具名、参数、耗时都刻在环带上。
- **大肥鱼页** — 躺在草地上的鲸鱼娘，agent 一干活她就醒，闲下来会睡回去，旁边实时列出工具调用清单和 KPI。
- **全程真实数据** — 没有模拟、没有假事件。壁纸显示的就是你的 agent 此刻在做的事。

> 壁纸数据来自本插件的本地事件流（`127.0.0.1:7788`），所以 **DSH 在跑，壁纸才有内容**。

---

## 安装

### 1. 前置

- Windows 10/11
- [Lively Wallpaper](https://www.rocksdanister.com/lively/)（免费开源动态壁纸软件，Microsoft Store 或官网）
- DeepSeek Harness（本插件运行在它里面）

### 2. 装插件

把本仓库装进 DSH 的 profile：

```bash
# 方式 A：直接链接本地目录（开发者）
dsh plugin add link:<本仓库路径>

# 方式 B：从 GitHub 安装
dsh plugin add <你的仓库地址>
```

或在 DSH 的 **设置 → 插件** 里点“从 URL 安装”，填入仓库地址。

### 3. 装壁纸

重启 DSH，然后在任意会话里输入：

```
/htbh install
```

它会自动：

1. 把壁纸素材铺进 `%LOCALAPPDATA%\Lively Wallpaper\Library\wallpapers\htbh.realdata`
2. 绑定到你当前的显示器
3. 启动 Lively Wallpaper

桌面没变化就去 Lively 里双击一下「**HTBH 实时数据壁纸**」这个缩略图。

### 其他命令

```
/htbh status      查看安装状态
/htbh uninstall   从 Lively 移除
```

---

## 你会看到什么

| 你的 agent 在做什么 | 壁纸的反应 |
|---|---|
| 工具调用（读文件、跑命令、搜索…） | 环上射出一道光柱，落点凝成光点，绕行后被黑洞吞入 |
| 思考 / 输出 | 圆环内的网各节点依次亮起，公式随机浮现 |
| 子代理 / 团队任务 | 环带出现对应标签，颜色按类型区分 |
| 空闲 | 环慢慢转，光柱消失，画面安静下来 |
| 大肥鱼页 | 她醒了就动，闲太久会睡回去 |

所有内容都来自真实事件流 —— **没有 agent 在跑的时候，它就是不活跃的**。

---

## 目录结构

```
assets/
  shell.html              双页外壳（圆环 / 大肥鱼 切换）
  circle.html             圆环页（自包含，~10 MB）
  haloflux-wallpaper.html 大肥鱼页
  live2d-inline.html      自包含 Live2D（大肥鱼页用）
  live2d/                 Live2D 模型 + Cubism Core
  pet/                    立绘 + 4K 唤醒/回睡视频
  music/                  自带两首示例曲（原始 FLAC，未压缩）
  decrypt/                加密音频解密内核（unlock-music）
lib/
  index.js                插件入口：事件桥 + /htbh 命令
  bridge.js               只读订阅 session/event，投影成本地 SSE
  installer.js            写入 Lively 壁纸库并绑定显示器
```

## 音乐

插件自带两首示例曲（`assets/music/`，**原始 FLAC 无损**，未做任何压缩），由插件自己的 `127.0.0.1:7788/music/*` 提供：

- 打开壁纸后 **点一下页面**（或点左下角「本地音乐」）就开始播放
- 面板里直接列出这两首，点哪首播哪首
- 想换成自己的音乐：点「选择文件夹」指向你的音乐目录即可
- 加密格式（`.kgm` / `.ncm` / `.qmc*` 等）会自动解密后播放

## 自定义

- **换音乐**：壁纸左下角「本地音乐」→ 选你自己的音乐文件夹（自带两首仍会保留）
- **换显示器**：Lively 里右键壁纸 → 指定屏幕
- **调效果**：`assets/circle.html` 里的 `C` 对象是一组可调参数（光柱密度、环速度、发光强度…）

## 许可

- 代码：[MIT](LICENSE)
- 立绘/视频：署名 **htbh**
- Live2D 模型：[CC BY-NC-SA 4.0](LICENSES/MODEL-LICENSE.txt)，署名 上善无形 / ZipZipPipe / 氵六青
- Live2D Cubism Core：Live2D Inc. 专有软件
- 示例音频：版权归原作者，仅演示用

详见 [LICENSES/ASSETS.md](LICENSES/ASSETS.md)。

## 致谢

- [Lively Wallpaper](https://github.com/rocksdanister/lively) — 壁纸宿主
- [unlock-music](https://git.unlock-music.dev/um/web) — 音频解密内核
- [Live2D Cubism](https://www.live2d.com/) — 模型运行时
- 鲸鱼娘模型：上善无形 / ZipZipPipe / 氵六青
