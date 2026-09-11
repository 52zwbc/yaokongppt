# 遥控PPT（yaokongppt）源码说明 —— Windows 开发指南

> 本文档供把源码拿到 **Windows** 电脑上继续开发时阅读。
> 版本：**0.6.0**　项目名：**遥控PPT**　框架：**Electron + electron-vite + electron-builder**
> 历史对话记录见项目根目录 `dialogue-log.md`（0.5.9 / 0.6.0 的修改与构建过程）。Linux 构建提示见本目录 `UBUNTU构建提示.md`。

## 1. 这是什么

一款基于 Electron 的**轻量 pptx 编辑与播放器**，支持：
- 本地编辑 / 放映 pptx
- 手机遥控（翻页、随机点名、常用语信息呼叫）—— 见 `apps/slides/resources/remote-control/control.html`
- 首次运行自动打开一页帮助 pptx（内容：请用微信小程序《52中文编程》查看使用帮助）

## 2. 目录结构

```
源码/
├── package.json            # 根：npm workspaces ["apps/*","packages/*"]
├── package-lock.json      # 锁文件（依赖版本保持一致）
├── tsconfig.base.json     # 各包共享 tsconfig
├── UBUNTU构建提示.md       # Linux 构建笔记（含平台差异说明，可参考）
├── README-WINDOWS开发说明.md
├── packages/              # @genoffice/* 共享依赖库
│   ├── electron-utils  i18n  metafile
│   ├── pptx-engine     pptx-render
│   ├── project-store   ui
└── apps/
    └── slides/            # 主应用 遥控PPT
        ├── package.json   # 版本 0.6.0，含 build 配置（win/mac/linux）
        ├── electron.vite.config.ts / tsconfig.json / vitest.config.ts
        ├── build/after-install.sh        # 仅 deb 安装脚本，Windows 用不到
        ├── resources/
        │   ├── icon.ico  icon.png        # 应用图标（任务栏/托盘/安装包）
        │   ├── remote-control/           # 手机遥控页 + sound/ + 常用语.txt + 常用语声音/
        │   └── _make_icon.py
        ├── src/
        │   ├── main/       # Electron 主进程（slides-main.ts 是入口核心）
        │   ├── preload/
        │   ├── renderer/   # React 界面
        │   └── shared/     # 主/渲染进程共享代码（ipc.ts 等）
        └── tests/          # vitest 单元测试
```

> 注意：本次拷贝**只含源码**，已剔除 `node_modules` / `release` / `out` 等构建产物。
> 这些是 Linux 上生成、Windows 上无法直接使用的，需在 Windows 上重新安装与构建。

## 3. 为什么不带 node_modules

- `node_modules` 是在 Linux 下 `npm install` 装的，其中的 **Electron 二进制**（~200MB）与 **koffi 原生模块**都是平台相关的，直接拷贝到 Windows 无法运行。
- 正确做法：在 Windows 上重新 `npm install`，并按第 5 节重建 koffi。

## 4. Windows 环境要求

- **Node.js ≥ 22.12.0**（建议用最新 LTS 22.x）
- **npm ≥ 10**（Node 自带）
- 构建工具链（koffi / node-gyp 需要，装一次）：
  ```powershell
  npm install --global windows-build-tools   # 或
  npm install -g node-gyp
  ```
  PowerShell 中请以**管理员身份**运行安装 VS Build Tools（仅需 C++ 桌面开发负载）。

## 5. Windows 上安装与启动

```powershell
# 1) 进入源码目录
cd 源码

# 2) 安装依赖（workspaces 会自动装全部包）。
#    electron 体积大、国内下载慢，可先设国内镜像：
$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
npm install

# 3) 重建 koffi 原生模块（针对 electron 43.3.0）
npm run rebuild-native -w yaokongppt

# 4) 开发模式（热更新）
npm run dev -w yaokongppt

# 5) 类型检查
npm run typecheck -w yaokongppt

# 6) 单元测试
npm run test -w yaokongppt
```

> `-w yaokongppt` 是 npm workspaces 语法，指 `apps/slides`（包名 `yaokongppt`）。

## 6. Windows 打包

根 `package.json` 已提供 `dist:win` 脚本，等价于：
```
electron-vite build && electron-builder --win
```
（koffi 重建已包含在 `apps/slides/package.json` 的 `dist:win` 中，根脚本也走 `-w yaokongppt` 的 `dist:win`。）

```powershell
npm run dist:win
# 产物：apps/slides/release/ 下的 NSIS 安装器（.exe）
```

打包配置（`apps/slides/package.json` 的 `build` 段）：
- `win.target`: nsis，x64
- `nsis`: 非一键、允许自选安装目录
- `extraResources`: `icon.ico` / `icon.png` / `remote-control` 目录（运行时会用到，勿删）

## 7. 0.6.0 版本相对说明（源自 dialogue-log.md）

- 任务栏 / 托盘图标：使用软件自带图标（`icon.png`），Linux 托盘不再空白
- 软件描述：已去掉“（从 GenOffice 提取，已移除 AI 功能）”
- 状态栏中间文案：`请用微信小程序《52中文编程》查看使用帮助和联系作者`
- 状态栏按钮“备注 / 放映”字号调小（12px / 13px），低分辨率不换行
- 首次运行自动打开一页帮助 pptx（标记文件 `slides-first-run.marker` 在 userData 目录）

## 8. 平台差异（重点：Windows 是"原生"平台）

与 Linux 不同，Windows 下这些能力**默认启用**（代码内 `process.platform` 分支，Windows 不降级）：
- `src/main/remote-control.ts`：koffi 调用 `user32.dll` 的 `keybd_event` / `mouse_event`（屏幕级键鼠遥控）、`showDesktop()`（Win+D）
- `src/main/roll-call.ts`：点名名单 `names.dll`（实为一行一个名字的文本文件，路径 `resources/remote-control/names.dll`）
- 托盘 `Tray`、自动播放策略、`fonts.ts` / `shaped-metrics.ts` / `license.ts` / `presenter-show.ts` / `slides-main.ts` 中的 Windows 分支均会走 Windows 路径

## 9. 常用 npm 脚本速查

在 `apps/slides` 目录执行（或加 `-w yaokongppt` 在根目录执行）：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发模式 |
| `npm run build` | 重建 koffi + 打包产物到 out/ |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | vitest 单元测试 |
| `npm run dist:win` | 构建 Windows 安装包（NSIS .exe） |
| `npm run dist:linux` / `dist:mac` | 其他平台（本机为 Windows 时仅能打 Windows 包） |

## 10. 回到本会话的交付物

- `源码/` 已放入**干净的源码**（剔除 Linux 构建产物），可在 Windows 上按本文档第 5、6 节安装与打包。
- 交付时请连同 `dialogue-log.md` 一起携带，方便后续追溯版本历史。