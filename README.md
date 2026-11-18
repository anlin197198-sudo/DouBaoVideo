# DouBaoVideo

Windows 桌面视频制作工作区，使用 Electron、React、TypeScript、React Flow 和本地 SQLite。

## 启动

开发环境使用 Node.js 24 或更新版本。

```powershell
npm ci
npm run dev
```

```powershell
npm run typecheck
npm test
npm run build
npm start
```

Electron 首次运行会下载对应平台的运行时。当前工程使用 Electron 内置 Node.js 的 `node:sqlite`，数据库由主进程统一管理。

## 当前可用功能

- 四个主页面和单任务画布。
- 创建七天周计划，启用或暂停计划，打开当天任务。
- 编辑和保存剧本、画布位置与视图，关闭程序后恢复已保存内容。
- 添加账号资料，标注会员档位、启停账号，打开各自独立的豆包登录窗口。
- 统一命令接口、输入校验、请求编号、事务、重复请求回执、版本冲突和错误日志。

账号登录状态核实、真实生成、多账号派发、定时和成片归档按 [功能开发文档](./功能开发文档.md) 的后续阶段接入。当前画布在点击保存或返回时保存编辑内容。

## 目录

```text
src/
  shared/           业务类型、命令契约与输入校验
  main/
    core/           错误与日志
    application/    用例注册与命令中间件
    infrastructure/ 数据库、迁移与仓储
    providers/      豆包能力接入边界
    electron/       会话窗口、IPC 来源校验与本地资源协议
  preload/          受限业务通信桥
  renderer/         极简页面与任务画布
tests/              持久化和中间件回归检查
```

## 本地数据

默认写入 Electron 的应用用户数据目录，工作区信息中可查看实际路径。目录包含 `workspace.sqlite`、`logs`、`media` 和独立账号的会话数据。

开发或测试时可指定一个独立目录。

```powershell
$env:DOUBAO_DATA_DIR = 'E:\DouBaoVideo\.local\development'
npm run dev
```

写操作使用请求编号保存事务回执。网络重试复用同一请求编号时，已提交的本地操作返回原结果。剧本保存同时核对任务版本，旧版本冲突会保留编辑区中的内容并反馈原因。

## 命令中间件

命令从受限的 preload 桥进入主进程，依次检查窗口来源、请求格式、已注册的命令和业务参数。写操作在同一事务中保存业务数据与请求回执，失败时一起回滚。结果统一携带请求编号，错误转换为前端可展示的类型，日志仅记录操作名称、耗时和错误类型。

豆包页面使用独立的会话窗口，应用业务接口只接受主工作区窗口的调用。接入模块当前明确返回能力待验证状态。
