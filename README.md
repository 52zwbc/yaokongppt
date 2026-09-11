# 遥控PPT（yaokongppt）

基于 Electron 的轻量 pptx 编辑与播放器，支持手机遥控翻页、随机点名、常用语信息呼叫。

> 本软件完全免费使用。微信搜索小程序《52中文编程》可以查看使用帮助。如果喜欢此软件，请微扫码支持一下。

![赞赏二维码](donate-qrcode.jpg)

- 仓库：https://github.com/52zwbc/yaokongppt
- 框架：Electron + electron-vite + electron-builder（monorepo，npm workspaces）
- 主应用：`apps/slides`（包名 `yaokongppt`，当前版本 0.6.1）
- License：Apache-2.0

## 功能

- 本地新建 / 打开 / 编辑 / 放映 pptx
- 文件菜单：新建（Ctrl+N）、关闭、打开、保存
- 开始选项卡：远程控制、随机点名、放映、备注
- 手机遥控页（`apps/slides/resources/remote-control/control.html`）：
  - 翻页、键鼠遥控（Windows 下经 koffi 调用 `user32.dll`，Linux 下降级为 no-op）
  - 随机点名（名单 `resources/remote-control/names.dll`，实为一行一个名字的文本文件）
  - 常用语信息呼叫：电脑屏幕置顶显示文字，有同名 mp3 则播放一次（`常用语声音/`），无则只显示
- 启动弹窗：免费说明 + 赞赏码（`donate-qrcode.jpg`），右上角 × 或底部“关闭”可关，屏蔽开关已预留（`src/renderer/donate-suppress.ts`，下个版本实现）
- 状态栏文案：`请用微信小程序《52中文编程》查看使用帮助和联系作者`
- 托盘：关闭窗口最小化到托盘，任务栏/托盘使用自带图标

## 目录结构

```
.
├── package.json            # 根：workspaces ["apps/*","packages/*"]，dist:win/mac/linux 入口
├── package-lock.json
├── tsconfig.base.json
├── README-WINDOWS开发说明.md  # Windows 开发指南（0.6.0）
├── UBUNTU构建提示.md          # Linux 构建笔记
├── 对话记录.md                # 版本修改追溯（v0.6.1 起）
├── donate-qrcode.jpg              # 赞赏码原图（renderer 内另有一份打包用拷贝）
├── packages/               # @genoffice/* 共享库
│   └── electron-utils i18n metafile pptx-engine pptx-render project-store ui
└── apps/
    └── slides/             # 主应用 遥控PPT
        ├── package.json    # build 配置：win(nsis x64)/mac/linux(deb+AppImage)
        ├── electron.vite.config.ts
        ├── resources/
        │   ├── icon.ico icon.png
        │   └── remote-control/  # control.html + sound/ + 常用语.txt + 常用语声音/ + names.dll
        ├── src/
        │   ├── main/       # slides-main.ts 入口，remote-control.ts / roll-call.ts 等
        │   ├── preload/
        │   ├── renderer/   # React 界面（Ribbon / App.tsx 等）
        │   └── shared/     # ipc.ts 等主/渲染共享代码
        └── tests/          # vitest 单元测试
```

注意：本仓库只含源码，已忽略 `node_modules/`、`release/`、`out/`、`dist/`。Electron 二进制与 koffi 原生模块是平台相关的，需在目标平台重新 `npm install` + 重建。

## 快速开始（Windows）

要求：Node.js ≥ 22.12.0，npm ≥ 10，VS Build Tools（含 C++ 桌面开发负载，供 koffi / node-gyp 用）。

```powershell
cd yaokongppt
$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
npm install
npm run rebuild-native -w yaokongppt
npm run dev -w yaokongppt      # 开发模式
npm run typecheck -w yaokongppt
npm run test -w yaokongppt
```

打包 Windows 安装包：

```powershell
npm run dist:win
# 产物：apps/slides/release/ 下 NSIS .exe
```

详见 `README-WINDOWS开发说明.md`。

## 构建（Ubuntu）

```bash
sudo apt update && sudo apt install -y build-essential python3
export ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
npm install
npm run rebuild-native -w yaokongppt
npm run dist:linux
# 产物：apps/slides/release/ 下 .AppImage / .deb
```

`apps/slides/package.json` 的 `build.linux` 需为 deb + AppImage，图标用 `resources/icon.png`（linux 不接受 .ico）。详见 `UBUNTU构建提示.md`。

平台差异：`remote-control.ts` 等 Windows 专属能力在非 win32 自动 return，不会崩溃；如需 Linux 下手机遥控键鼠，需另接 `xdotool` / `libxdo` / `uinput` 实现。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev -w yaokongppt` | 开发模式 |
| `npm run build -w yaokongppt` | 重建 koffi + electron-vite build |
| `npm run typecheck -w yaokongppt` | 类型检查 |
| `npm run test -w yaokongppt` | vitest 单元测试 |
| `npm run dist:win` / `dist:linux` / `dist:mac` | 各平台打包 |

## 版本历史

- v0.6.1（当前）：文件菜单新增新建/关闭；“停止远程控制”改名“远程控制”并去掉弹窗内停止按钮；启动只显示空白文件；启动赞赏弹窗（屏蔽逻辑预留）；构建 AppImage + deb 验证（45 文件 / 437 用例通过）。详见 `对话记录.md`。
- v0.6.0：任务栏/托盘图标修复、状态栏文案与字号调整、首次运行帮助 pptx（0.6.1 已改为不再打开）。

## 相关文档

- `README-WINDOWS开发说明.md` — Windows 开发指南
- `UBUNTU构建提示.md` — Linux 构建提示
- `对话记录.md` — 每次修改的对话追溯
