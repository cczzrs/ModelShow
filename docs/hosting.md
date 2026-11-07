# 共享模型池与托管

[返回项目入口](../README.md) · [开发维护](development.md)

## 模型池只保存定义

“模型管理”中的本地文件／JSON 加载、下载定义与共享池操作相互独立。合法 JKM 可以直接加载到当前页面；保存到共享临时组是单独操作。池中模型只保存 7.0.0 JKM 定义，不保存正在执行的 q、双 FIFO、输出历史或界面状态。现场续算使用独立快照。

前端和服务端共用 `compileModel` 校验，旧版本或无效结构不会被自动改写。读取池失败时报告错误，保留当前有效模型；本地导入、执行和下载仍可使用。

共享池保留原权限：

- 查看和加载模型不需要管理员口令。
- 临时模型可公开导入、删除。
- 将模型转为永久或删除永久模型，需要有效管理员口令。
- 每次实际写入核对客户端 revision，并在成功后递增。冲突返回 HTTP 409，不自动重放操作。

管理员口令通过本次请求的 Authorization 头发送，不进入 JKM、脚本、快照、URL、前端构建或共享池文件。

## V7 存储命名空间

新版使用 `model-pool-v7.json`，与旧版本存储分开。旧存储不是新版输入，不读取或迁移为 V7，也不因新版初始化而覆盖；旧文件保留不意味着维护旧版运行能力。

池外层继续保存管理元数据，model 字段必须是完整 JKM：

```json
{
  "version": 1,
  "revision": 0,
  "temporary": [],
  "permanent": []
}
```

条目字段为 `id`、`createdAt`、`promotedAt`、`model`。临时条目的 promotedAt 是 null；永久条目保存晋升时间。名称相同的模型仍以独立条目 ID 区分。池 version 是管理协议版本，不是 JKRD 规则版本。

`html/example.json` 是新版初始种子。只在 V7 存储尚不存在时初始化；已有数据、损坏 JSON、读取异常与重新部署都不能触发种子覆盖。

## 本地服务

开发模式分别运行 `./tools/dev.sh` 与 `./tools/dev.sh api`。Vite 将 `/api/model-pool` 代理到本地 5174 端口。未启动 API 不影响本页模型执行。

`./tools/dev.sh build` 后可通过 `./tools/dev.sh serve` 同时提供生产前端和本地模型池。默认本地池文件为 `html/server/.data/model-pool-v7.json`。存储使用版本摘要、排他锁和临时文件替换防止覆盖并发修改；运行数据不加入 Git。

本地管理员口令通过 `MODEL_POOL_TOKEN` 或 `html/server/.env` 配置，已有环境变量优先。`MODEL_POOL_ALLOWED_ORIGINS` 可声明额外允许来源，同源默认允许。文件不属于前端资源，Vite 与生产静态服务均不应公开它们。单次 API 请求上限为 32 MiB。

## Sites Worker 与 R2

保留现有 `.openai/hosting.json` 项目身份及 `BUCKET` 绑定。Sites Worker 使用该绑定读写 `model-pool-v7.json`；不需要个人 S3／R2 Access Key。前端使用同源 `/api/model-pool`，`/example.json` 由服务端返回当前共享池。

R2 首次创建使用 `If-None-Match: *`，已有池使用同次读取获得的 ETag 做条件写入。客户端 revision 和存储 ETag 分别防止应用级、存储级并发覆盖。响应丢失或写入结果未确认时返回错误，由用户刷新核对，不能自动重放写入。

永久模型的权限检查由本地和 Worker 共用服务实现。线上 `MODEL_POOL_TOKEN` 作为服务端密钥独立配置；不得写入托管清单、模型或前端构建。

构建产物包括 `dist/client`、`dist/server/index.js` 与 `dist/.openai/hosting.json`。构建不会将种子作为 `/example.json` 静态文件覆盖 Worker 的实时接口。

## 本次范围

本次请求更新本地 ModelShow 项目，不提交 Git、不发布线上版本、不改线上模型池。保留 Worker/R2 代码与权限，并不表示新版已经部署。实际 HTTPS 环境的 WebGPU、资源类型、下载、全屏与在线存储仍需在发布后按授权范围验收。
