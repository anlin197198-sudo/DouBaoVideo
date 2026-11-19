# F07 DeepSeek 单次联通冒烟

这是开发验证工具，默认不用。只在获得**对一次可能计费请求的明确授权**，且密钥通过受控环境注入后运行。不要把密钥直接写在命令行、仓库或日志中。脚本不会读取本地项目业务数据、剧本文件或账号资料。

在仓库目录中，受控进程环境必须同时提供以下三项：

- `DOUBAO_DEEPSEEK_ENABLED=1`
- `DOUBAO_DEEPSEEK_SMOKE=1`
- `DEEPSEEK_API_KEY`（已受控注入，不显示值）

一次运行只发一条文字请求：

```sh
node --import tsx scripts/deepseek-f07-smoke.ts --confirm-one-billable-request
```

请求只使用脚本内置的两镜头合成文本，输出上限 256 tokens、60 秒超时，不自动重试。使用正式 DeepSeek 传输和 F07 分镜候选结构校验。输出只有 PASS/FAIL、模型 ID 和通过结构检查的镜头数；PASS 必须是恰好两镜头，非 PASS 退出码为 1。退出失败或超时不表示一定未计费。

该工具不验证桌面操作、私有剧本生成、候选采用、图像或视频。托管 `deepseek-flash` 不是固定版本地址，脚本不证明实际使用的权重版本；参考 [DeepSeek 官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)。

开发阶段使用注入的 HTTP 模拟验证门禁、单次请求、结果校验和输出脱敏；这不是一次实际联通记录。
