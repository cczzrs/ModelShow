# 项目文件清理与目录整理记录

日期：2026-09-14。基于本地工作区实际内容，保留开始时已有的未提交界面重构。未提交 Git，未发布。

## 检查范围与处理结果

逐项盘点了 106 个自有项目文件及本地配置/历史产物，另按用途检查 `.git/`、`node_modules/`、`dist/` 三棵管理或生成目录。原有 62 个文件移动到职责明确的目录；移出 15 个无现行引用的文件或目录元数据，共 13,584,749 字节（约 12.96 MiB）。其中 `dist/.DS_Store` 单独从生成目录清理，不在前述自有文件计数中。

所有运行时模块都有职责，均保留。30 个测试文件全部保留，业务断言没有因目录整理而删除。图片、图标、旧模型夹具的移动已比对 SHA-256，原字节保持。实际环境文件只核对存在，不读取或公开内容，不改变模型池位置。

恢复资料在本机临时目录 `/private/tmp/modelshow-cleanup-20260914/`：`removed/` 按原路径保留移出文件，`README.before.md` 保留整理前说明，`before-inventory.json`、`moves.json`、`removed.json` 记录原清单、移动和移出项。两张未引用的道路图片是独立原始素材，保留恢复副本，不按可再生产物处理。

## 目录职责

```text
index.html               固定页面结构、控件和原生模板
src/
  main.js                页面入口与模块协调
  config.js              只读 APP_CONFIG 默认树
  style.css              页面样式
  core/                  表达式、节点编号、FIFO、播放与帧更新
  input/                 图片加载、像素/位序映射及弹窗控制
  output/                输出配置、灯画板及弹窗控制
  models/                模型池规则与管理界面
  scene/                 WebGPU 场景、布局、控制及资源
assets/                  实际使用的图片与图标
server/                  Node/Sites 接口与本地/R2 存储适配
scripts/                 构建与分组测试入口
tests/                   core/input/output/models/scene/ui/server 专项测试
  fixtures/              真实图片与旧模型兼容夹具
  helpers/               测试辅助
  bench/                 手动渲染基准
docs/                    主题说明、历史参考图片与验证记录
public/example.json      默认模型池种子
```

## 内容精简

- 删除 main 中过时的 layered 布局分支和注释旧代码，删除 view 的未使用参数。
- 删除输出控制器未读取的绑定/字段、模型管理未消费的 connectionError、配置树中未消费的 channel.kind。
- 删除无 HTML/JS 匹配的图片弹窗 CSS 类及被后续无条件规则覆盖的旧声明；保留最终级联和全局 hidden 规则。
- Node 服务复用已有 failure/readPool，去掉重复 helper 和纯转发包装；HTTP、JSON、权限、ETag/R2 协议不变。
- 展开手动基准 HTML；保持原控件、文本、脚本和三条 CSS 规则，不执行性能基准。
- README 去掉旧待办、重复布局叙述和过期实现状态；模型 JK/FIFO、标签、草稿应用、旧 scale 兼容等契约保留在主题文档。

## 原文件逐项结论

“移出”均对应上述临时恢复副本；“移动”保留文件职责。路径以清理开始时的快照为准。

| 原路径 | 处理 / 现路径 | 保留或清理依据 |
| --- | --- | --- |
| `.DS_Store` | 移出 | 移除 macOS 目录显示元数据。 |
| `.gitignore` | 保留原位 | 保留忽略规则，补充 .pnpm-store/，避免本地包缓存再次进入源码。 |
| `.openai/hosting.json` | 保留原位 | 当前 Site 项目标识、R2 绑定 `BUCKET` 和 D1 声明；build 复制到 `dist/.openai/hosting.json`。 |
| `.pnpm-store/v11/index.db` | 移出 | 误入项目的本地缓存；当前包管理配置未指向它，可重建。 |
| `README.md` | 保留原位 | 改为快速入口；现行模型语义、功能和开发协议拆入五份主题文档，删除旧待办和重复叙述。 |
| `artifacts/modelshow-sites-preview.tar.gz` | 移出 | 移出无运行引用的历史构建或验证产物，恢复副本保留旧版本字节。 |
| `artifacts/modelshow-sites-publish.tar.gz` | 移出 | 移出无运行引用的历史构建或验证产物，恢复副本保留旧版本字节。 |
| `artifacts/modelshow-sites-r2-live.tar.gz` | 移出 | 移出无运行引用的历史构建或验证产物，恢复副本保留旧版本字节。 |
| `artifacts/modelshow-sites-r2.tar.gz` | 移出 | 移出无运行引用的历史构建或验证产物，恢复副本保留旧版本字节。 |
| `artifacts/output-display-ui.tar.gz` | 移出 | 移出无运行引用的历史构建或验证产物，恢复副本保留旧版本字节。 |
| `artifacts/preview-validation.json` | 移出 | 移出无运行引用的历史构建或验证产物，恢复副本保留旧版本字节。 |
| `dev.sh` | 保留原位 | 保留 Node 运行时回退；向各命令转发参数，支持定向测试及自定义端口。 |
| `docs/sites-compatibility.md` | 移出 | 移出过时静态托管报告；当前 Worker/R2 契约整理到 hosting.md。 |
| `docs/ui-html-refactor-validation.md` | 移动 → `docs/validation/ui-html-refactor.md` | 保留上次界面重构验证证据，更新维护入口和历史测试路径；不把上次 138 项计作本次通过数。 |
| `favicon.ico` | 移动 → `assets/icons/favicon.ico` | 3,538 B。index.html `rel=icon` 引用，Vite 生成哈希资源。 |
| `image-V1.png` | 移动 → `docs/images/image-V1.png` | 2552×1430，1,550,332 B。README 第 2 行引用；实际查看确认是旧版本网络界面截图。 |
| `image-V2.png` | 移动 → `docs/images/image-V2.png` | 2560×1434，789,952 B。README 第 3 行引用。 |
| `img/b1.png` | 移动 → `assets/images/b1.png` | 1472×828，1,731,389 B。HTML 基础图片按钮、APP_CONFIG 默认 preset、图片 UI 测试/README 引用。 |
| `img/b2.png` | 移动 → `assets/images/b2.png` | 1470×830，1,459,514 B。HTML 第二个基础图片按钮、图片 UI 测试/README 引用。 |
| `img/有积水的马路-大图.png` | 移出 | 项目内无引用的独立原始图片，移出并保留字节一致的恢复副本；不声称可重新生成。 |
| `img/有积水的马路.png` | 移出 | 项目内无引用的独立原始图片，移出并保留字节一致的恢复副本；不声称可重新生成。 |
| `index.html` | 保留原位 | 保留静态页面、弹窗、详情及原生模板；更新两个基础图片和图标路径，移除无消费的 editor 数据属性。 |
| `package.json` | 保留原位 | 保留 three/Vite 依赖及脚本；test 改用递归分组入口。 |
| `pnpm-lock.yaml` | 保留原位 | 锁定 three/Vite 及传递依赖、各平台可选构建包；根 importer 与 `package.json` 的两个版本吻合。 |
| `pnpm-workspace.yaml` | 保留原位 | 当前内容为 `allowBuilds: esbuild: true`，承载依赖构建许可。 |
| `public/example.json` | 保留原位 | 离线示例池；Node store 首次初始化读取、Sites Worker 打包为首次 R2 种子、Vite preview 中间件读取、engine 测试读取。 |
| `scripts/build.mjs` | 保留原位 | 清空 `dist`、构建 Vite 客户端、删除静态 `example.json`、构建 Sites Worker、复制绑定声明。由 `package.json build` 和 `dev.sh build` 使用。 |
| `server/.env` | 保留原位 | 本地服务启动时按 `new URL('.env', import.meta.url)` 加载。 |
| `server/.env.example` | 保留原位 | 环境配置模板；README 指示本地配置，`.gitignore` 明确保留示例文件。 |
| `server/.env.sites` | 保留原位 | 本机曾保存的独立环境配置；当前仓库源码没有该文件名引用。 |
| `server/local-model-pool-store.js` | 保留原位 | 本地种子初始化、SHA-256 ETag、锁文件、临时写入和原子重命名。由本地服务入口使用，服务端专项测试间接验证。 |
| `server/model-pool-api.js` | 保留原位 | Fetch API 路由、JSON 流大小限制、CORS、token 比较及 HTTP 响应；由 `sites-worker.js` 和 `tests/sites-model-pool.test.js` 使用。 |
| `server/model-pool-server.js` | 保留原位 | 本地 Node HTTP 入口，处理 API、静态资源、`.env` 加载；`package.json` 的 `api/start`、`dev.sh` 的 `api/serve`、`tests/model-pool-server.test.js` 直接引用。 |
| `server/model-pool-service.js` | 保留原位 | 共享数据读取、模型池解析、revision/ETag 与永久模型权限变更入口。由 Node、Fetch API、两个 store 使用。 |
| `server/sites-r2-store.js` | 保留原位 | Sites `BUCKET` 的 `model-pool.json` 读取、首次条件迁移、ETag 条件写入、限流/不确定结果处理。由 Worker 及 Sites 专项测试使用。 |
| `server/sites-worker.js` | 保留原位 | 线上 Worker 入口，引用 `cloudflare:workers`、种子数据、R2 store 和 Fetch API；由构建脚本作为 library entry 编译。 |
| `src/buffer-updates.js` | 移动 → `src/scene/buffer-updates.js` | 合并 GPU 待上传范围；network-batches/output-board 调用 |
| `src/config.js` | 保留原位 | 页面冻结默认树；main/image/output/playback/layout/view 读取 |
| `src/edge-curves.js` | 移动 → `src/scene/edge-curves.js` | 自环、双向边分道、浮动曲线、缓冲更新；view/output-board 调用 |
| `src/editor-controls.js` | 移动 → `src/scene/editor-controls.js` | Three Trackball 扩展、光标锚点缩放；view 调用 |
| `src/engine.js` | 移动 → `src/core/engine.js` | 表达式/模型编译与 FIFO 状态执行；main/model-pool/server 间接调用 |
| `src/frame-updates.js` | 移动 → `src/core/frame-updates.js` | 同步数据回调与每帧刷新合并；main 使用 |
| `src/fullscreen.js` | 移动 → `src/scene/fullscreen.js` | 原生及页面内全屏、静态详情面板迁移；main 使用 |
| `src/image-input-loader.js` | 移动 → `src/input/image-input-loader.js` | PNG/APNG/JPEG/WebP 校验、解码、EXIF/首帧合成与释放；image-input-ui 使用 |
| `src/image-input-ui.js` | 移动 → `src/input/image-input-ui.js` | 静态图片弹窗控制、选区、模板数据、Canvas 预览 |
| `src/image-input.js` | 移动 → `src/input/image-input.js` | 纯图像选区、像素/位序/Xi 映射；UI/loader 使用 |
| `src/layout-worker.js` | 移动 → `src/scene/layout-worker.js` | 布局后台入口；view 使用 new URL 创建 Worker |
| `src/layout.js` | 移动 → `src/scene/layout.js` | 1D–5D/自动布局、SCC、可读性评分；view/worker 调用 |
| `src/main.js` | 保留原位 | 页面入口、控制器串接、队列、节点详情、帧循环；index.html 启动 |
| `src/model-manager.js` | 移动 → `src/models/model-manager.js` | 模型池界面、本地暂存、远端授权、下载；main 使用 |
| `src/model-pool.js` | 移动 → `src/models/model-pool.js` | 浏览器与 Node/Sites 共用模型池格式、版本、变更校验 |
| `src/network-batches.js` | 移动 → `src/scene/network-batches.js` | 节点、连线、箭头实例化批绘制与资源回收；view 使用 |
| `src/node-id.js` | 移动 → `src/core/node-id.js` | JK 编号/tag 校验、排序、引用解析、显示 ID；engine/main/layout/view 使用 |
| `src/node-labels.js` | 移动 → `src/scene/node-labels.js` | 字形图集与实例化文字；view 使用 |
| `src/output-board.js` | 移动 → `src/output/output-board.js` | WebGPU 灯画板、通道连线、拾取与边界；view 使用 |
| `src/output-display-ui.js` | 移动 → `src/output/output-display-ui.js` | 静态输出设置弹窗、草稿、转换、应用、预览 |
| `src/output-display.js` | 移动 → `src/output/output-display.js` | 输出配置校验/求值/调整/导出与脏灯追踪 |
| `src/playback.js` | 移动 → `src/core/playback.js` | 暂停/单步/动画/跳过预算/事件调度；main 使用 |
| `src/render-schedule.js` | 移动 → `src/scene/render-schedule.js` | GPU 提交频率、交互尾帧、隐藏页时钟；view 使用 |
| `src/resources.js` | 移动 → `src/scene/resources.js` | 去重释放 group 拥有的几何/材质/贴图；view/board/batches 使用 |
| `src/style.css` | 保留原位 | 全部界面静态样式与有限动态变量消费 |
| `src/view.js` | 移动 → `src/scene/view.js` | 场景、布局、GPU 恢复、选择、传播动画、画板 |
| `tests/.DS_Store` | 移出 | 移除 macOS 目录显示元数据。 |
| `tests/edge-drift-cache.test.js` | 移动 → `tests/scene/edge-drift-cache.test.js` | 2项：缓存风动与原始独立公式逐分量对照、时间反向和种子/速度变化。 |
| `tests/editor-controls.test.js` | 移动 → `tests/scene/editor-controls.test.js` | 4项：跨极点旋转、平移、鼠标缩放锚点、限制和监听释放。 |
| `tests/engine.test.js` | 移动 → `tests/core/engine.test.js` | 21项：完整解析、真值表、FIFO副本、触发、状态读取、隔离、播放及旧格式导入。 |
| `tests/ex-total.test.js` | 移动 → `tests/core/ex-total.test.js` | 4项：运行EX操作统计、历史独立性、反馈不同播放模式、失败不部分累计。 |
| `tests/fixtures/feedback.json` | 移出 | 全仓无引用；相关反馈/异常业务断言已在实际测试中内嵌，测试本身保留。 |
| `tests/fixtures/image-input-animated.webp` | 保留原位 | 140字节，loader扩展VP8X/尺寸/截断测试。 |
| `tests/fixtures/image-input-oriented.jpg` | 保留原位 | 668字节，loader EXIF orientation测试。 |
| `tests/fixtures/image-input-poster.apng` | 保留原位 | 238字节，loader独立静态封面/动画首帧/EXIF/合成资源失败测试。 |
| `tests/fixtures/image-input-rgb.jpg` | 保留原位 | 868字节，loader基础JPEG/尺寸/截断测试。 |
| `tests/fixtures/image-input-rgba.png` | 保留原位 | 80字节，loader/UI均使用；不能仅看没有literal全名就删，loader动态拼名。 |
| `tests/fixtures/image-input-rgba.webp` | 保留原位 | 60字节，loader无损VP8L/尺寸/截断测试。 |
| `tests/fixtures/invalid-nodes.json` | 移出 | 全仓无引用；相关反馈/异常业务断言已在实际测试中内嵌，测试本身保留。 |
| `tests/frame-loop.test.js` | 移动 → `tests/ui/frame-loop.test.js` | 3项：真实main帧函数异常恢复及RAF延续。仅需更新main文件读取路径。 |
| `tests/frame-updates.test.js` | 移动 → `tests/core/frame-updates.test.js` | 3项：每次求值立即观察但仅帧尾刷新；观察/刷新异常不丢更新。 |
| `tests/helpers/ui-harness.js` | 保留原位 | main-ui、frame-loop、node-tag-view、ui-structure四文件直接使用。读取实际HTML及main函数，避免只验证复制实现。源码函数抽取对目录迁移需更新路径。 |
| `tests/image-input-loader.test.js` | 移动 → `tests/input/image-input-loader.test.js` | 11项：真实格式头/EXIF/APNG首帧拼接/大小限制/资源释放；所有六张fixture均引用。 |
| `tests/image-input-ui.test.js` | 移动 → `tests/input/image-input-ui.test.js` | 13项：预置图片、异步竞态/取消、失败保留、选框缩放、生命周期及单次绑定。 |
| `tests/image-input.test.js` | 移动 → `tests/input/image-input.test.js` | 11项：像素/透明底色/RGB灰度/位序/Xi精确映射、容量和独立默认、填入不发送。 |
| `tests/jk-logic-structure-v262.json` | 移动 → `tests/fixtures/jk-logic-structure-v262.json` | engine/layout直接读取，1564字节原用户旧模型兼容证据；保留字段及MD5。 |
| `tests/layout.test.js` | 移动 → `tests/scene/layout.test.js` | 13项：六布局、坐标方向、间距、球壳、局部选择、布局不改运行状态。 |
| `tests/main-ui.test.js` | 移动 → `tests/ui/main-ui.test.js` | 3项：真实队列可见区/历史60条/固定节点详情切换及已应用灯值。 |
| `tests/model-export.test.js` | 移动 → `tests/output/model-export.test.js` | 7项：两个导出入口一致、模型深度身份、草稿独立配置、旧字段/MD5及副本不变。 |
| `tests/model-manager.test.js` | 移动 → `tests/models/model-manager.test.js` | 32项：共享/离线管理、授权、冲突、取消、重连、本页临时、下载、生命周期。759行但不是重复无效大文件，不为缩短删断言。 |
| `tests/model-pool-server.test.js` | 移动 → `tests/server/model-pool-server.test.js` | 15项：本地HTTP服务、权限、并发/ETag、存储故障、CORS、32MiB限制、静态路径安全。即使Sites tests覆盖R2，独立Node HTTP入口仍需验证。 |
| `tests/model-pool.test.js` | 移动 → `tests/models/model-pool.test.js` | 11项：池格式、分组顺序、旧数据、版本变更、纯函数不变性、非法数据。 |
| `tests/network-batches.test.js` | 移动 → `tests/scene/network-batches.test.js` | 7项：批量绘制对象数、局部上传范围、隐藏期间更新、选择、拾取及释放。 |
| `tests/node-labels.test.js` | 移动 → `tests/scene/node-labels.test.js` | 6项：共享图集、GPU字形实例、隐藏、尺寸兼容、容量成长、资源所有权。 |
| `tests/node-tag-view.test.js` | 移动 → `tests/scene/node-tag-view.test.js` | 5项：ID标签在布局、场景、选择、详情的表现；与tagged-ids纯逻辑互补。 |
| `tests/output-batch.test.js` | 移动 → `tests/output/output-batch.test.js` | 6项：逐发布聚合与帧尾灯色提交、重复值、重配/布局/恢复正确性。 |
| `tests/output-display-ui.test.js` | 移动 → `tests/output/output-display-ui.test.js` | 8项：静态控件、草稿、已应用导出、转换、位序、批量、释放；假DOM实现虽与其他UI测试类似，但事件与选择器能力不同，不宜本轮强行合并。 |
| `tests/output-display.test.js` | 移动 → `tests/output/output-display.test.js` | 17项：聚合、位序、64位、无损转换、配置隔离、画板几何/GPU颜色及恢复。 |
| `tests/playback-batch.test.js` | 移动 → `tests/core/playback-batch.test.js` | 15项：时间预算、10k上限、模式切换、FIFO反馈oracle、回调异常与重入保护。 |
| `tests/render-benchmark.html` | 移动 → `tests/bench/render-benchmark.html` | README有开发入口引用；真实浏览器基准的静态入口，非test runner用例。 |
| `tests/render-benchmark.js` | 移动 → `tests/bench/render-benchmark.js` | 896节点/3136边有界基准；自动151 RAF/60暂停RAF后停止，手动恢复；无逻辑事件。更新src imports。 |
| `tests/render-integration.test.js` | 移动 → `tests/scene/render-integration.test.js` | 6项：真实View和合批/图集/选择/布局/调度/恢复联动；GPU模拟边界保留。 |
| `tests/render-schedule.test.js` | 移动 → `tests/scene/render-schedule.test.js` | 8项：30/60Hz目标、暂停休眠、交互唤醒、后台冻结、时钟边界。 |
| `tests/resources.test.js` | 移动 → `tests/scene/resources.test.js` | 2项：不能释放全局共享Sprite几何、自有资源只释放一次。 |
| `tests/sites-model-pool.test.js` | 移动 → `tests/server/sites-model-pool.test.js` | 10项：Sites BUCKET适配、首次条件迁移、并发条件写入、权限、故障保留；不能以名称带sites视为旧静态文档同类。 |
| `tests/tagged-ids.test.js` | 移动 → `tests/core/tagged-ids.test.js` | 13项：固定ID/标签兼容、非法标签、重复身份、BigInt排序、事件和导出不变性。 |
| `tests/ui-structure.test.js` | 移动 → `tests/ui/ui-structure.test.js` | 4项：静态HTML/模板唯一性、禁止JS建界面、CSS写入名单、冻结默认与兼容。`--lamp-width`名单虽当前未写，属于已授权动态变量，不宜仅因未用删除规则。 |
| `tests/view-counts.test.js` | 移动 → `tests/scene/view-counts.test.js` | 1项：通过真实 NetworkView.refresh 验证计数颜色、句柄/纹理复用。与 node-labels 的单元测试层次不同，不能直接删。 |
| `tests/view.test.js` | 移动 → `tests/scene/view.test.js` | 7项：相机不变、曲线端点、重复/反向/自环分离、固定缓冲区、风动连续性。 |
| `vite.config.js` | 保留原位 | 相对 base、`dist/client` 输出、开发 API 代理、静态预览读取种子中间件。被 Vite dev/build/preview 自动读取。 |

## 生成目录和新增文件

| 路径 | 结论 |
| --- | --- |
| `.git/` | 版本历史和索引，保留；未修改、暂存或提交。 |
| `node_modules/` | 包管理器维护的第三方依赖，保留。按依赖声明、锁文件和构建实际使用检查，不宣称逐行审计第三方源码，不手工删传递依赖。 |
| `dist/` | 可再生构建产物，已用本次源码重新构建；移除其中目录元数据，不作为源码维护。 |
| `dist/.DS_Store` | 从生成目录移出，恢复副本单独保留。 |
| `scripts/run-tests.mjs` | 新增递归发现、按分组或文件执行以及 --list；迁移后测试入口仍能发现全部 30 个文件。 |
| `docs/model-format.md` | 从 README 整理出的模型 JSON、JK 顺序执行、FIFO 和兼容规则。 |
| `docs/usage.md` | 从 README 整理出的输入、播放、图片和输出画板用法。 |
| `docs/rendering.md` | 从 README 整理出的场景、布局、相机、全屏和渲染边界。 |
| `docs/hosting.md` | 当前本地服务、模型池和 Sites Worker/R2 说明。 |
| `docs/development.md` | 新目录维护入口、UI 边界、定向测试和手动基准入口。 |
| `docs/project-file-audit.md` | 本次逐文件处理与验证记录。 |

## 本次验证

本地 Local 工作区执行，无云端测试、无真实 R2 写入、无全流程回归、无性能基准。浏览器测试使用一次性内存模型池，不写本地实际模型池。

以下 9 个文件合计 **102 项通过**：

```sh
./dev.sh test ui tests/core/engine.test.js \
  tests/input/image-input-ui.test.js tests/input/image-input-loader.test.js \
  tests/output/output-display-ui.test.js tests/models/model-manager.test.js \
  tests/scene/view.test.js
```

服务端两文件 **25 项通过**，本轮合计 **127 项 / 11 文件**：

```sh
./dev.sh test server
```

- `./dev.sh test --list` 列出 30 个文件；分组清单无遗漏或重复。不传分组的 test 会执行全套，本次没有使用该运行方式。
- AST 检查 66 个 JS/MJS 文件、156 个本地模块/URL 引用，均可解析；构建脚本删除产物的 URL 按用途单独判定。
- HTML 开发入口、手动基准和构建入口的 10 个资源引用、文档 29 个本地链接均存在；`git diff --check` 通过。
- `./dev.sh build` 成功生成客户端及 Worker，Vite 正确处理两张图片、favicon 与 layout-worker；保留已有大 chunk 提示。
- 外部 Chrome 开发页与生产预览均显示 WebGPU 已连接：两张预置图片加载成功，生产路径为 Vite 哈希资源；1D/4D 布局切换正常。
- Chrome 确认图片弹窗重开、灯固定值 128 应用后重开保留；暂停发送 216 项队列后滚动到底，DOM 仅 6 行，行高 36px。
- 全屏走页面内回退时，JK 详情仍可见，退出后恢复；390×844 下图片弹窗宽 358px，页面宽与滚动宽均 390px，无横向溢出。
- Chrome 两个验收页面均未记录控制台 error。临时视口覆盖已恢复；未把此定向检查宣称为所有功能、原生全屏或完整布局回归。
- 以本次检查为界，不把历史 138 项或完整测试静态计数当成本次运行结果。
