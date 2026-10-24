# Moyer Mail

个人用的多邮箱管理器：QQ、Gmail、Outlook、163 等邮箱放在一起收发，外语邮件一键翻译。
磨砂玻璃 + 纯色背景的界面，所有操作“先改界面、后台同步”，点开即出。

详细方案见 [docs/方案设计.md](docs/方案设计.md)。

![界面截图](docs/screenshot.png)

## 安装

到 [Releases 发布页](https://github.com/MoyerZhang-Claude/moyer-mails/releases/latest) 下载 `MoyerMail-Setup-x.x.x.exe`，双击安装（Windows 10/11）。安装包没有数字签名，Windows 可能提示“未知发布者”，点“更多信息 → 仍要运行”即可。

关闭窗口时软件会缩到右下角托盘继续收信；要彻底退出，右键托盘图标 → 退出。

## 添加邮箱

| 邮箱 | 需要准备 |
|---|---|
| QQ 邮箱 | 网页版 设置 → 账号与安全 → 开启 IMAP/SMTP，生成**授权码**（不是 QQ 密码） |
| 163 / 126 | 网页版 设置 → POP3/SMTP/IMAP → 开启服务，获取**授权码** |
| Gmail | Google 账号开启两步验证 → 生成**应用专用密码**；大陆网络需要代理（设置 → 网络代理，默认跟随系统代理） |
| Outlook / Hotmail | 微软已关闭密码登录。先在 设置 → 账号登录 填写“微软应用 ID”（页面里有图文步骤，只需一次），再用“微软账号授权”登录 |
| 其他 | 选“其他邮箱”，填写 IMAP / SMTP 服务器 |

## 翻译

- 读信：外语邮件顶部会提示“这封邮件是 xx 语”，点“翻译”在原位翻译，保留排版；按 `T` 切换原文/译文。
- 划词：在邮件里选中一段文字，点弹出的“翻译”。
- 写信：用中文写好，底部选目标语言点“翻译成”，可以“回译检查”意思对不对，再替换正文或中外文对照发送。回复时会自动选成对方邮件的语言。
- 默认用 Google 免费翻译；也可以在 设置 → 翻译 换成微软 Azure（每月 200 万字符免费）、DeepSeek 等大模型或 DeepL。

## 快捷键

`J/K` 上下封 · `C` 写信 · `R` 回复 · `A` 全部回复 · `F` 转发 · `T` 翻译 · `S` 星标 · `U` 已读/未读 · `E` 归档 · `Delete` 删除 · `/` 搜索 · `Ctrl+Enter` 发送 · `Esc` 关闭弹窗

## 开发

```bash
npm install
npm run dev        # 开发模式（热更新）
npm test           # 引擎自动化测试（本机假 IMAP/SMTP 服务器）
npm run web        # 只在浏览器里看界面（演示数据）
npm run dist       # 打包 Windows 安装程序到 dist/
```

本地调试真实收发流程：`node tests/fake-servers.mjs` 会启动假的 IMAP（127.0.0.1:1143）和 SMTP（127.0.0.1:1025），用户名 `testuser`、密码 `testpass`，在软件里选“其他邮箱”、加密方式选 STARTTLS 即可连上（自签名证书，需要设置环境变量 `NODE_TLS_REJECT_UNAUTHORIZED=0` 启动）。

数据目录：`%APPDATA%\Moyer Mail\`（可用环境变量 `MOYER_DATA_DIR` 指定，便于便携使用）。

## 目录

```
src/shared/    界面与引擎共用：类型、MailApi 接口、服务商预设、语言、配色
src/core/      收发信引擎（纯 Node）：同步、发信、OAuth、翻译、数据库
src/main/      Electron 主进程：窗口、托盘、通知、IPC
src/preload/   安全桥
src/renderer/  React 界面
tests/         引擎端到端测试、假邮件服务器
scripts/       图标生成
```
