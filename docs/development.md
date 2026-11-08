# 开发与维护

[返回项目入口](../README.md) · [模型池与托管](hosting.md)

## 本地命令

使用 Node.js 22.12+。`./tools/dev.sh` 优先使用系统 Node.js，缺少时尝试本机 Codex runtime，不改变系统配置。依赖按 pnpm 锁文件安装。

| 命令 | 用途 |
| --- | --- |
| `./tools/dev.sh` | Vite 开发服务，默认 127.0.0.1:5173 |
| `./tools/dev.sh api` | 本地模型池 API，默认 127.0.0.1:5174 |
| `./tools/dev.sh build` | 构建 Vite 前端和 Sites Worker |
| `./tools/dev.sh preview` | 预览生产前端，不运行 Sites Worker |
| `./tools/dev.sh serve` | 运行已构建前端及本地模型池，默认 127.0.0.1:4173 |
| `./tools/dev.sh test jkrd7` | 仅运行 JKRD7 改动相关测试 |
| `./tools/dev.sh test --list` | 列出测试文件，不执行 |

前端根目录是 `html/`，网址不带 `/html/`。不要通过 `file://` 打开模块入口；使用本地 HTTP 或 HTTPS。前端依赖本地打包，不依赖远程脚本和字体。Vite 禁止静态读取 `html/server/`、环境文件和 Git 数据。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `html/index.html` | 固定页面、对话框和变长内容的模板 |
| `html/main.js` | JKM 加载与交互、RGB／JKM 标签切换、文件保存 |
| `html/config.js` | 递归冻结的 APP_CONFIG 默认值树 |
| `html/style.css` | 页面样式、布局与响应式规则 |
| `src/jk/model-schema.js` | JKM、运行脚本、现场快照校验及索引 |
| `src/jk/engine.js` | JavaScript 串行执行与异步／合格批计算入口 |
| `src/jk/gpu-compute.js` | WebGPU EX 计算与缓冲区管理 |
| `src/jk/node-id.js` | 绝对路径排序与层级处理 |
| `src/jk/model-pool.js` | 共享池校验和 revision 变更纯逻辑 |
| `src/jk/rgb-workspace.js` | RGB_3X3 的 JKRD7 组合、独热输入绑定与完整 bit 帧校验 |
| `src/ui/rgb-workspace-ui.js` | 独立 RGB 执行实例、原页面交互、场景与灯阵配置缓存 |
| `src/ui/rgb-image-*.js` | 原图片解码、选区、颜色／位序提取，产出 bit 数组 |
| `src/ui/rgb-output-*.js` | 原 RGB 编辑器、通道与打包位、亮度计算 |
| `src/ui/rgb-model-manager.js` | 原模型管理界面与新版模型池接口 |
| `src/ui/rgb-workspace-config.js` | 独立 .rgb.json 配置捕获与校验 |
| `src/ui/node-tree.js` | JKM 节点层级、边框用途标签、键盘选择与场景选中同步 |
| `src/scene/network-view.js` | JKRD7 与原场景的协调、播放动画，不定义执行语义 |
| `src/scene/model-view.js` | 绝对路径、观察端点和通知／取值的纯展示投影 |
| `src/scene/view.js`、`layout.js` 等 | 保留原 Three.js／Canvas 效果、相机和布局算法 |
| `html/server/` | 本地 HTTP、共用权限服务、Sites Worker 与 R2 |
| `html/example.json` | 只包含 JKRD7 定义的共享池种子 |
| `tests/` | 正式测试源码及运行入口 |
| `tests/jkrd7/` | 中央参考对拍、静态拒绝、快照与异步批检查 |
| `docs/` | 现行产品文档与维护说明 |
| `dist/` | 可重新构建的 client、server 与 hosting 产物 |

## 留档管理

验证截图、状态快照、过程报告、历史资料、备份和发布留档统一存放在系统临时目录，不在项目目录中保留这些留档。按任务组织临时留档并保留其相对结构；产品文档不依赖某次任务的临时绝对路径，也不将临时文件作为永久链接入口。

留档记录保留原日期、协议版本、验证平台、实际覆盖范围和未验证事项。历史资料不作为现行契约；定向检查通过不表示全流程回归或真实硬件均已通过。正式测试源码继续放在 `tests/`，产品文档继续放在 `docs/`。

## 界面维护约束

页面使用原生 HTML/CSS 与 JavaScript ES modules。固定控件和 `<template>` 由 HTML 定义；JavaScript 只克隆模板、填充 textContent／表单属性并绑定事件。不要拼接 HTML、动态构建页面结构或生成 CSS。选择和错误状态通过 class 切换。

产品默认值统一在 `html/config.js` 的冻结树 `APP_CONFIG` 中。固定 HTML 仅声明控件；初始化、恢复默认与缺失缓存字段均读取此树。已有有效浏览器设置优先于默认值，调整默认值不会覆盖用户缓存。运行中的模型选择、文件内容、当前相机位置和解码后的画布尺寸属于运行状态；JKM 初值属于模型数据，不用界面默认补齐规则。

| 配置路径 | 职责 |
| --- | --- |
| `workspace.active` | 初始 RGB／JKM 工作区 |
| `desktop.display / windows / geometry / split / rail` | 单板双板、模块位置与尺寸、显隐收展、层级、侧栏宽度及占比 |
| `desktop.theme / appearance / windows.*.appearance / rail.appearance` | 全局毛玻璃与颜色、模块公共外观、窗口局部覆盖、菜单和程序坞图标文字 |
| `scene.camera / controls` | 相机投影、初始位置、复位方向与留白、旋转平移和缩放参数 |
| `scene.styles.edges / nodes` | 连线和节点样式、范围与缓存键；`nodes.computationTypes.ex.marker` 独立管理 JKM 的 x 显隐、颜色和字号 |
| `scene.nodeMarker / renderer / layout / outputBoard` | 未应用 JKM 样式的视图标记、渲染后端、网络布局及场景灯阵基础值 |
| `scene.nodeLabelsHidden / blackBackground` | 初始名称显隐和纯黑背景；按钮与渲染同时读取 |
| `view.disclosures / inspector / queues` | 两个工作区的折叠状态、节点树展开层级、队列显示上限 |
| `model.example / presets / defaults` | 默认示例、每个模型的文件标识及输入／观察预设、导入模型的通用默认；切换默认示例不会误用另一模型的路径 |
| `engine / gpu / playback` | 计算平台、预算、GPU 参数及播放速度；默认 WebGPU 会在两种工作区启动时初始化，计算等待初始化结果 |
| `image` | JKM 图片阈值、像素上限、入口选择索引及预览 |
| `rgb.imageInput` | RGB 图片选区、编码位序、导入定位策略、视图、滚轮与预览参数 |
| `rgb.outputBoard` | 默认灯模式、通道来源、亮度进制、位串、初始选中灯、首次映射与批量工具 |
| `pool` | 模型池地址和超时 |

外观继承只在树内进行：公共值来自 `desktop.appearance`，每个窗口可在 `desktop.windows.*.appearance` 覆盖；单板布局覆盖来自 `desktop.display.modes.single.windows`。ex／q 的节点属性默认继承基础类别，显式用途标签保持优先；x 的颜色和显隐独立，不继承场景前景色或名称显隐。RGB 保留 `scene.nodeMarker` 的原有基础配色。

RGB 图片的 `import.selection` 支持 `configured`（默认，读取配置坐标和尺寸）、`center`（保留当前尺寸并居中）与 `retain`（保留当前选区）；均按图片边界裁剪。`import.view` 支持 `fit`（默认，根据图片与窗口尺寸适应）和 `configured`（读取 `view.scale/x/y`）。适应策略下坐标是计算结果，切换到 configured 才使用固定初始视图坐标。

RGB 灯阵的 `pixel.mode` 可为 channels／packed，`channel.kind` 可为 fixed／bits。选择 bits 或 packed 默认模式时，必须同时配置合法的观察路径；packed 位数必须匹配通道位宽总和，不自动生成模型路径。`initialAssignment` 控制首次模型加载是否自动分配输出、起始输出索引与灰度方式；它与 `batch` 批量工具的初始选项职责不同。

Canvas／WebGPU 绘图属于图形展示；其位图、几何、缓冲区与临时图像资源按所有权管理。图片取样、文件操作或异步设备操作完成前，应防止旧请求覆盖新模型。界面不得在一个活动处理单元中途注入通知或保存快照。

RGB／JKM 标签及两个面板都在静态 HTML 中声明，控件 ID 分开；RGB 逻辑首次进入时加载。切换先等待当前完整处理单元结束并暂停，随后隐藏原面板、显示目标面板，各自引擎与用户输入保持独立。

RGB 的 `.rgb.json` 是独立的 ModelShow 配置文件，包含模型名称、bindings 与 display；导入前校验当前模型和观察引用，不扩展 JKM。灯阵配置在页面内按模型定义加绑定缓存，不把内存缓存宣称为持久化。RGB 输入用绑定对选择独热入口，默认 216 位完整帧由已定义的 M_REG 与 all 完成节点组合处理，不引入旧版运行规则。

## 定向验证

只运行本次改动涉及的测试，不默认执行全流程回归；需要全流程回归时先请求批准。前端功能使用外部 Chrome 检查。

RGB 本次改动可选择对应专项文件；仅在改动涉及整个 JKRD7 实现时选择完整的 `jkrd7` 分组。

```sh
./tools/dev.sh test tests/jkrd7/rgb-input.test.js tests/jkrd7/rgb-output.test.js
./tools/dev.sh build
```

JKRD7 对拍测试通过 Python 读取相邻中央项目 `../JK` 的定义与串行参考，期望结果不来自待测 JavaScript 实现。记录包含源文件 SHA-256，测试以 `PYTHONDONTWRITEBYTECODE=1` 运行，不写中央项目，不导入或执行 CUDA 后端。

主要比较对象为全部标准记录、最终 q／到达记录／登记轮／FIFO，以及中央中间快照恢复后的剩余记录。异步 EX 与安全批使用相同记录对拍。GPU 回调模拟不能证明硬件正确性，真实 WebGPU 单独由 Chrome 验证。

RGB 输入专项包含完整帧与中央 Python 串行参考对拍；这只能证明相应模型和输入的记录一致，不能代替浏览器图片解码、文件选择、真实 GPU 或 3D 灯阵验证。前端操作与硬件实际覆盖范围以验证记录为准。

真实 GPU 专项页面为开发服务的 `/gpu-validation.html`，手动点击“开始验证”。它比较 67 个固定场景的 Python 预期记录与完整快照；无 GPU 显示 SKIP，有任何 CPU 回退均不能通过。该页面不在生产构建入口中。中央规则或参考工具发生变化时，先重新生成前端 fixture：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tests/jkrd7/reference-oracle.py > tests/jkrd7/browser-cases.json
```

报告记录中央源 SHA-256，不能把旧 fixture 的通过当作新规则验证。若文件变更未触发 Vite 热更新，重新启动开发服务后刷新 Chrome，确认服务提供当前源码再验证。

`tests/run.mjs` 支持分组和单文件选择；不带选择参数会运行全部测试，应仅在已批准需要全量时使用。构建用于验证客户端和 Worker 的导入与打包，不表示已发布。

## 协作和发布

开始 JK 相关工作前，读取中央 AGENTS.md、JKRD7.md、README.md 和 jk.config.json。尚未定义的行为保持明确边界，不从历史版本推断。变更默认规则须有批准依据。

Git 提交必须先请求批准，说明理由并给出建议提交说明。完成本地更新不会自动提交、推送或发布线上 Sites。模型池运行数据、管理员口令及环境文件独立保留，不属于可删除的构建缓存。
