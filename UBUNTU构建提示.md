# 遥控PPT (v0.5.9) Linux 构建提示

> 给在 Ubuntu 上接手构建的 AI / 开发者阅读。本目录是 Windows 开发机导出的 **monorepo 干净源码**（npm workspaces），已去除 `node_modules` / `release` / `out` / `out_bak_*` 等构建产物。
> 基线：git commit `c261f24` / 前版本 `v0.5.8`→当前 `v0.5.9`。

## 1. 目录结构
```
ykppt-src-linux/
├── package.json            # 根：workspaces: ["apps/*", "packages/*"]，含 dist:linux 脚本(当前指向 dist:dir)
├── package-lock.json       # 锁文件，保证依赖版本一致
├── tsconfig.base.json      # 各包 tsconfig 继承
├── packages/               # @genoffice/* 共享依赖（apps/slides 依赖它们）
│   ├── electron-utils  i18n  metafile  pptx-engine  pptx-render  project-store  ui
└── apps/
    └── slides/             # 主应用 遥控PPT（electron-vite + electron-builder）
        ├── package.json    # 版本 0.5.9，build 段含 win(nsis)/mac/linux(deb+AppImage)
        ├── src/  resources/  tests/  electron.vite.config.ts  tsconfig.json ...
        └── resources/remote-control/   # 遥控页(control.html) + names.dll + sound/ + 常用语.txt + 常用语声音/
```

## 2. Ubuntu 上构建步骤
```bash
cd ykppt-src-linux

# (1) 安装系统工具（koffi 原生模块编译需要）
sudo apt update && sudo apt install -y build-essential python3

# (2) 装依赖（workspaces）。electron 43.3.0 体积大，慢就走镜像：
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
npm install

# (3) 重建 koffi 原生模块（针对 electron，脚本已用 npmmirror dist-url）
npm run rebuild-native -w @genoffice/slides

# (4) 构建 linux（见下方第 3 节，需先补 linux target）
npm run dist:linux
```

## 3. 必须修改：electron-builder 加 linux target
当前 `apps/slides/package.json` 的 `build` 段只有 `win`(nsis) 与 `mac`，**没有 `linux`**。请补：

`apps/slides/package.json` 的 `build` 内新增（与 `win`/`mac` 同级）：
```json
"linux": {
  "target": ["deb", "AppImage"],
  "category": "Office",
  "icon": "resources/icon.png"
}
```
> 注意：electron-builder 的 `icon` 在 linux **不接受 `.ico`**，需提供 png（如 `resources/icon.png`）。`win` 段用 `.ico` 可保留——electron-builder 按平台选对应图标。

并把构建脚本真正走 linux：
- `apps/slides/package.json` 的 `scripts` 加：
  `"dist:linux": "electron-vite build && electron-builder --linux"`
- 根 `package.json` 的 `scripts.dist:linux` 改为：
  `npm run build -w @genoffice/slides && npm run dist:linux -w @genoffice/slides`
  （当前它指向 `dist:dir`，只输出未打包的 release/ 目录。）

构建产物位于 `apps/slides/release/`（deb / AppImage）。

## 4. 平台差异（重点：已做保护，通常不会崩）
源码对 Windows 专属能力都用 `if (process.platform !== 'win32') return` 降级，**linux 上自动 no-op，不会加载 user32.dll、不会崩溃**：
- `src/main/remote-control.ts`：koffi 直调 `user32.dll` 的 `keybd_event` / `mouse_event`（屏幕级键鼠遥控）、`showDesktop()`（Win+D）均在非 win32 直接 return。
- `src/main/roll-call.ts`：`names.dll` 实为文本文件（一行一个名字），跨平台可读（`path.join(rollAssetsDir(),'names.dll')` 读取）。
- `fonts.ts` / `shaped-metrics.ts` / `license.ts` / `presenter-show.ts` / `slides-main.ts`：均有 `process.platform` 分支，linux 走通用/默认路径。
- 托盘 `Tray`、autoplay 策略（`--autoplay-policy=no-user-gesture-required`）跨平台可用。

可选增强（非必须）：若要在 linux 上也支持"手机遥控键鼠"，需用 `xdotool` / `libxdo` / `uinput` 另写 linux 实现替换 koffi 分支；本次可保持 no-op。

## 5. 验证清单（构建后启动确认）
- [ ] 打开/放映 pptx 正常
- [ ] 手机遥控页 WebSocket 连接成功（`control.html` 可点翻页/随机点名/常用语按钮发送信息呼叫）
- [ ] 信息呼叫：电脑屏幕置顶显示文字 + 有同名 mp3 则播放一次（`常用语声音/`），无则只显示
- [ ] 随机点名 / 常用语固定按钮正常
- [ ] 关闭窗口最小化到托盘、托盘菜单显示/退出可用
