# JK 空间对齐与定向验证（2026-10-02）

[项目入口](../README.md) · [现行执行与快照契约](model-format.md)

依据 [JK规则与设计](https://chatgpt.com/space/page_1cee9c7aae188191be3608cbf94fb889)（最终核对序列 90，更新时间 2026-10-02 09:09 UTC）及 [ModelShow设计文档](https://chatgpt.com/space/page_f0054dda6f3c81918b9985ba46e2f092) 调整本地源码。用户提供的 `ModelShow_JK_stage2_2026-10-02.zip` 用作参考，重点核对公共快照校验、状态成员指纹、当前 q 导出及独立 FIFO 对照；没有整包覆盖，也没有引用附件中的测试数字作为本地结果。

## 已落实的行为

- 逐来源 FIFO：发送只追加 Xi 事件；消费时更新单个 Xi，按目标 Q 编号执行完整 EX。单步消费一次来源通知，可完成多个节点求值。
- `initial_q` 单独决定状态分类；有状态引用读取最新实际 q，历史通知不回滚 q。无状态来源使用事件携带值，按目标独立维护跨次到达屏障。
- 完整 EX 提交 q 后执行四种 propagation 条件；同值结果继续逐次发布，被过滤的通知不会进入下游屏障。`q=` 仅允许有状态节点。
- Yi 和 RGB 灯读取当前绑定 q；来源事件、求值、当前输出及最近发布分开显示。详情使用 HTML 中的“状态 / EX / 事件”三个固定分支，新增默认值纳入冻结的 APP_CONFIG 树。
- 文件/JSON 公共导入与模型池读取要求完整合法快照；统一校验固定连续 ID、EX、来源约束、到达 DAG、状态分组、216 位端口上限、统计、容量、时间与双指纹。错误不会替换当前有效模型。
- 新 format_md5 包含有状态节点 ID 集合，排除其 0/1 值；显式默认传播规范化为省略。仅完整合法、无 propagation 字段且两种旧指纹均匹配的模型可以克隆迁移。
- 当前模型下载和画板导出保存实际有状态 q 与已应用画板配置；草稿保留自身状态与画板。明确编辑计算结构时重算派生字段，仅篡改指纹或统计仍拒绝。

## 定向功能测试

以下 20 个本次相关测试文件共 **199 项通过、0 项失败**：

```sh
./dev.sh test \
  tests/core/engine.test.js tests/core/jk-rules.test.js \
  tests/core/fifo-oracle.test.js tests/core/model-schema.test.js \
  tests/core/tagged-ids.test.js tests/core/ex-total.test.js \
  tests/core/frame-updates.test.js tests/core/playback-batch.test.js \
  tests/models/model-manager.test.js tests/models/model-pool.test.js \
  tests/server/model-pool-server.test.js tests/server/sites-model-pool.test.js \
  tests/output/model-export.test.js tests/output/output-display.test.js \
  tests/output/output-display-ui.test.js tests/output/output-batch.test.js \
  tests/ui/frame-loop.test.js tests/ui/main-ui.test.js \
  tests/ui/ui-structure.test.js tests/scene/node-tag-view.test.js
```

独立 FIFO 对照不使用内核解析器、目标表或缓存来决定求值，覆盖两个固定种子生成的 120 个有限五节点网络、960 轮部分及重复发送；分别比较执行顺序、参数、q、发布、到达缓存、计数与 Yi。其它用例补充历史状态通知、条件过滤、播放模式一致性、非法结构、迁移和导出边界。该范围不等于任意网络等价证明。

`./dev.sh build` 的前端与 Sites Worker 构建均通过。前端仍有产物大于 500 kB 的体积提示，本次没有进行性能基准或拆包改造。

## 外部 Chrome 验证

本地开发地址 `http://127.0.0.1:5173/`，WebGPU 显示已连接；共享后端未启动，测试导入使用本页临时模型，没有线上写入。

| 检查 | 实际结果 |
| --- | --- |
| 暂停发送与单步 | Q0=`K(X0)K(X1)`，初值 0；发送 1/1 后只有两个 Xi 入队。两次单步读取 (1,0)、(1,1)，q 均为 1；随后消费两个 Q0 通知，累计 4 来源事件、2 求值、4 EX 操作 |
| 条件过滤与跨次屏障 | Q0 的 q= 静默提交 1；Q1 的 q=1 过滤 0；Q3 等待 Q1、保留 Q2=1。单独补发 X1=1 后 Q3 读取 Q1=1、Q2=1、Q0=1，执行一次并清空屏障 |
| 静默状态与画板 | 动画模式暂停后单步 X0=1，Q0 在 1/0 间更新，Yi 与灯的红色亮度在 255/0 间同步；Q0 始终“尚未发布”，Q3 未额外求值 |
| 错误保留 | 完整快照的 md5 改为全零后拒绝导入，原场景、q、求值次数及输出保留 |
| 旧模型迁移 | 合法旧双指纹经 JSON 入口导入，编辑区读回新 format_md5，原 md5 保持一致 |
| 当前状态下载及恢复 | 模型管理下载文件保存 Q0=1，md5 改变、format_md5 不变；经 JSON 入口恢复后 q=1、队列与计数为 0、没有初始化发布 |
| 画板导出 | 实际下载的 `jk-model-with-display (8).json` 与只读导出 JSON 完全一致；包含当前 Q0=1、已应用 RGB 绑定及有效双指纹 |

Chrome 的自动化下载通知曾超时，但实际文件成功生成，已从下载目录读取并核验。文件选择自动化因扩展未启用 “Allow access to file URLs” 未完成；没有修改浏览器权限，导入与恢复的浏览器检查使用 JSON 入口。

## 保留的边界

本次没有运行全流程回归、Git 提交或网站部署。标准快照不保存 Xi、无状态运行结果、待消费来源事件、到达缓存或播放进度，不能恢复未结束现场。空间尚未定案的动态节点创建、连接、分配回收与完整恢复没有实现；10,000 项来源队列保护也不是业务存储容量。
