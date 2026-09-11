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
