# Windows 安装与升级验收（F20）

本表对应《功能开发文档》F20 与第 10 节；通过编译、生成安装包和在 Windows 上完成验收是三件不同的事。每次验证记录代码 SHA、应用版本、Windows 版本、安装包 SHA-256、测试的数据版本与实际结果。测试使用新建的隔离 Windows 用户和合成素材，不使用日常工作区，不记录凭据或会话内容。

仅验证生产版桌面流程（不安装、不联网）时，使用[隔离离线验收与合成素材](Windows-本地制作离线验收.md)。桌面启动结果不能代替本表的安装或升级结果。

## 构建

在 Node.js 24 或以上的 Windows 构建机运行：

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package:win
Get-FileHash dist/windows/*-Setup.exe -Algorithm SHA256
```

只检查生产应用目录时，运行 `npm run package:win -- --dir`，检查 `dist/windows/win-unpacked`（无需 Wine 即可在 Linux 云端生成目录，但不能作为 Windows 安装验收）。Linux 构建完整 NSIS 安装器使用 electron-builder 提供的固定版本 Wine 工具，运行环境须允许 Wine 使用本地套接字；不在目标用户电脑上安装构建工具。

完整构建命令必须成功退出；失败时留下的临时 EXE 不是安装包，不可发布。预期产物位于 `dist/windows`。生产资源只允许打包编译后的主进程、preload、渲染器和必要运行依赖。检查安装包内容，不应包含 `.env`、`.local`、用户数据库、登录状态、日志或素材。此命令不发布，不应把未签名的验证包当正式版。

## 云端 Windows 构建备选

[`windows-ci.example.yml`](./windows-ci.example.yml) 是未启用的构建模板。经仓库所有者授权后，可放到专门验证分支的 `.github/workflows/`，使用 [GitHub 托管 Windows x64 构建机](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。模板先跑测试，再生成未签名安装包并记录 SHA-256；公开仓库只记录校验结果，不上传安装包。它不会发布 Release、访问账号会话或改动用户电脑。首次安装、启动和升级仍需下面的独立验收。

## 验收顺序

| 场景 | 操作 | 通过标准 |
| --- | --- | --- |
| 全新安装 | 用普通用户安装至带空格、中文的路径；从开始菜单与桌面快捷方式启动 | 无需在目标机预装 Node.js；能显示工作区，首次 SQLite 初始化完成 |
| 文件与界面 | 分别从中文目录导入两张图片，设置保存位置；检查 100%、125%、150% 缩放 | 预览和选择正常；常用按钮无遮挡；成片路径能打开 |
| 单实例与持久化 | 创建一条有剧本、镜头、资产和首尾帧的任务并确认；连续两次启动应用 | 同一数据目录只运行一个有效调度实例；新启动定位到已有窗口；任务不重复 |
| 关闭、托盘与恢复 | 验证最小化到托盘、托盘退出、重新启动；在支持的流程中分别模拟提交、生成、下载期间中断 | 退出后重新打开可读到执行记录；未知提交不盲目重发；重试下载不再次生成 |
| 同名文件与成片 | 以授权的真实账号生成可用测试成片，或在未测通时只用合成媒体验证本地播放 | 记录真实路径是否已验收；中文路径、同名文件和播放不丢资料；合成数据不能作为真实出片凭证 |
| 升级前后 | 用旧版在隔离 Windows 用户下建立任务、素材、成片文件及授权测试会话；退出旧版，备份；为新版递增版本号并使用同一应用标识覆盖安装 | 首次启动完成迁移；版本和关键记录一致；素材可读、成片可播、授权会话仍隔离；实际登录失效时明确提示 |
| 取消与失败 | 分别取消安装向导、在隔离副本模拟数据库或素材路径不可写 | 不破坏旧版本或原数据；软件显示失败原因，不将失败误标为完成 |
| 回退与卸载 | 先在隔离位置演练恢复升级前的备份；卸载时保留本地数据，重装后核对数据 | 不会误清理工作区；跨版本恢复用已验证的备份，不让旧程序直接写新结构数据库 |

签名、托盘、真实账号生成、跨日定时以及完整升级迁移以实测记录为准。未验证处保持“待验证”；不记录口令、Cookie 或 Token。

## 2026-11-19 最新云端目录回归

构建代码基线：`159abe75d599ea35aa9be0c0c0260c7d71c0d2b0`，独立云端克隆，应用版本 `0.1.0`，Electron `45.3.4`。本轮只新增验证文档，不修改打包或生产代码。

执行命令：

```bash
npm run package:win -- --dir
npm test
git diff --check
```

- 目录打包退出码 0，脚本内 `npm run build` 包括两组 TypeScript 检查并成功；锁文件指定的 Windows x64 生产依赖在临时 staging 安装，未修改主工作区依赖或系统设置。
- 全量测试 **170/170**，0 失败／0 跳过，差异检查通过。
- 静态读取 `app.asar` 的 1372 个条目及 `win-unpacked` 的 79 个实体文件；入口 `out/main/index.js`、`out/preload/index.cjs`、`out/renderer/index.html` 齐全，主进程引用的 preload 路径一致。首次检查脚本误把 preload 后缀写成 `.js`，更正为源码实际的 `.cjs` 后通过；并非产物缺失或代码修复。
- 主进程内包含「打开主窗口／查看任务队列／退出」菜单文字，内嵌托盘 PNG 经 sharp 解码为 **16×16**。这是打包资源检查，不是系统托盘实际交互验收。
- 检查 EXE 和下列文件的 MZ／PE 头，机器类型均为 `0x8664`（x64）：
  - `DouBaoVideo.exe`
  - `app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node`
  - 同目录 `libvips-42.dll`、`libvips-cpp-8.18.7.dll`
- 打包路径清单未发现 `.env`、`.local`、数据库／WAL／SHM、会话／profile／Cookie／Local Storage／IndexedDB 或日志路径；asar 根未包含源码、测试、文档或 Git 目录。该结论结合脚本仅复制编译输出和依赖的白名单，不是对任意依赖文本进行秘密扫描的声明。

本次产物 SHA-256：

| 产物 | SHA-256 |
| --- | --- |
| `resources/app.asar` | `166a1781ae1d0993c1951a778db8d5ea3e1fba66c79e426abd17ca9ea12b884e` |
| `DouBaoVideo.exe` | `91771c99fa19db8a99e33050fde9a2948e63d41223c8eb70d3f5d4750fcec4df` |

产物保留在本次独立克隆的 `dist/windows/win-unpacked`，未提交到 Git、未上传或发布。它是未签名的应用目录，不是安装包；没有执行其中的 Windows 二进制。应用 EXE 图标仍为默认 Electron 图标，与已内嵌托盘图标是两件事。构建仍提示缺少 author、依赖重复引用及第三方 `use no memo` 指令警告，未阻止本次目录成功。

没有重试已知受本地套接字限制的 Linux NSIS 路径，也没有启用 GitHub Actions。Windows 安装／升级、原生启动、sharp 实际加载、托盘和真实账号等仍须按上表完成独立验收。

## 2026-11-19 F07 / F10 增量后目录复查

代码基线 `3a4c8f2`，独立云端克隆；本轮仅更新验证文档，没有修改生产或打包代码。

- 精确执行 `npm run package:win -- --dir`，退出 0；内含类型检查与生产构建。仅运行 Windows x64 目录路径，没有重试 NSIS 安装器、启用 CI 或发布。
- `npm test` **246/246**，0 失败／0 跳过；`git diff --check` 通过。
- 实际 `app.asar` **1372** 条、应用目录 **79** 个实体文件；三个 main/preload/renderer 入口齐全，自有编译文本 5 个。实际主程序与本次编译输出字节一致。
- 编译内容包含本地 DeepSeek 配置就绪边界说明、明确写入空白提示词与已保存镜头汇总 UI。仅证明资源已打包，不是功能运行验收。
- 实际归档自有文件只有 `out` 与 `package.json`。未发现源码、测试、文档、scripts、smoke 脚本或用户附件目录；路径清单未发现 `.env`、`.local`、Cookie、会话／profile、Local Storage／IndexedDB、日志、数据库及 WAL／SHM。
- 编译自有文本未发现工作区绝对路径或 source map。`DEEPSEEK_API_KEY` 是符号属性读取，读取的是运行时 `env` 参数（默认 `process.env`），没有构建时值替换。检查未读取环境变量值或用户凭据。
- 粗略 `sk-` 模式命中 8 个较长标识符子串，边界限定后独立密钥形态为 0；只报告数量及分类，没有显示匹配原文。该有限模式扫描与路径白名单不是全格式、全依赖秘密审计的保证。
- `DouBaoVideo.exe`、sharp `.node` 及两份 libvips DLL 的 PE 机器类型均为 x64，四个文件齐全。

本次产物摘要：

| 产物 | SHA-256 |
| --- | --- |
| `resources/app.asar` | `aa9b2bd571b9a59471bf00fae1374083668467b72c477d2439c8d7c869ca0d49` |
| `DouBaoVideo.exe` | `e4618a2c6bd1c4da21db838609463373bb4c43a823e7681d2d84419a9e982ecc` |

产物留在本次独立克隆的被忽略目录，不入 Git、不上传。独立只读审查复核 staging 白名单、实际 archive、自有 main 字节一致及 runtime 密钥符号，未发现阻断。仍为未签名目录，EXE 使用默认 Electron 图标；author 缺失、重复依赖及 `use no memo` 是非阻断警告。未启动 Windows 二进制，未验证安装／升级／原生加载／真实服务或计费。

## 后续首启前的隔离要求

普通双击会使用默认数据目录，不适用于仅合成数据的烟测。先遵守 [Windows隔离启动契约与记录表](Windows-隔离启动烟测.md)。已提供默认不启动的 Node 隔离启动器；本轮仅验证合成输入与子进程观察边界，尚未实跑 Windows。窗口归属与空工作区必须人工核对，子进程退出码不是验收结果。

## Windows x64 解包产物静态核对

`npm run package:win -- --dir` 生成解包目录后会核对产物；也可用 `npm run audit:win` 单独复核。它要求根目录 `out/` 来自同次生产构建，逐个比较 `app.asar` 内的文件清单与 SHA-256，包含主进程、预加载、渲染入口及渲染资源。旧产物、同长度但字节不同的文件、缺失或多出的资源都会失败。解包的 EXE、sharp 原生模块和 2 个 libvips DLL 还要符合 Windows x64 PE32+ 头及预期文件类型。

该检查是本地只读的产物核对，不运行可执行文件，不证明程序集可加载、签名有效、NSIS 安装成功、界面能打开或生成功能已验收。独立 Windows 测试仍依照上面的验收清单进行。

F17 私有探测页打包后，静态检查还要求专用 HTML 入口、资源清单和 JS 构建文件均存在。即使归档与构建结果互相匹配，若两者同时漏掉该入口也会失败。检查不注册探测协议或启动窗口。
