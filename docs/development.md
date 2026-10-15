# 开发与维护

[返回项目入口](../README.md) · [共享模型池与托管](hosting.md)

## 本地流程

使用 Node.js 22.12+ 与 pnpm。`pnpm install` 根据锁文件安装依赖。`./tools/dev.sh` 优先使用系统 Node.js，缺少时尝试本机 Codex runtime；它不改变系统 Node 配置。

| 命令 | 用途 |
| --- | --- |
| `./tools/dev.sh` | Vite 开发服务，默认 127.0.0.1:5173 |
| `./tools/dev.sh api` | 本地模型池 API，默认 127.0.0.1:5174；可与开发服务同时运行 |
| `./tools/dev.sh build` | 构建 Vite 前端和 Sites Worker |
| `./tools/dev.sh preview` | 预览生产前端，沿用本地 API 代理；未连接 API 时支持本页导入和下载 |
| `./tools/dev.sh serve` | 本地生产前端与共享模型池，默认 127.0.0.1:4173 |

修改开发源码后由 Vite 更新；生产预览需要重新构建。不要以 `file://` 打开入口，模块、Worker和WebGPU需要合适的浏览器上下文。页面前端资源本地打包，不使用远程CDN或字体。WebGPU不可用时显示明确提示，不回退WebGL。

Vite 以 `html/` 为页面根目录，不使用独立 `public/` 目录；浏览器入口仍为 `/`，不用在网址中添加 `/html/`。功能模块保留在项目根目录的 `src/`。`html/server/` 是服务端源码和本地数据目录，开发服务禁止通过静态文件接口读取它。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `html/index.html` | 固定界面和原生模板 |
| `html/main.js` | 页面初始化、界面填充、帧循环和控制器协调 |
| `html/config.js` / `html/style.css` | 只读页面默认值 / 样式与响应式布局 |
| `src/jk/` | JK执行器、表达式与完整快照校验、固定ID、双指纹和模型池纯数据；校验与模型池数据模块同时供服务端使用 |
| `src/ui/` | 图片解码与像素提取、输入弹窗、Yi聚合与画板配置、输出弹窗、模型管理、播放与帧尾刷新 |
| `src/scene/` | WebGPU场景、布局及Worker、相机、合批、字形、曲线、全屏、GPU输出画板绘制和资源 |
| `html/server/` | 本地HTTP服务、共用权限/版本服务、Sites Worker与R2适配 |
| `html/favicon.ico`、`html/b1.png`、`html/b2.png` | 与页面同层的图标和基础图片，由 HTML 引用并经 Vite 打包 |
| `html/example.json` | V4 分组模型池种子，本地静态预览可读取 |
| `tools/dev.sh` | 本地开发、API、构建、预览和测试命令的统一入口 |
| `tools/vite.config.js` / `tools/build.mjs` | Vite配置 / 前端与Sites Worker构建流程 |
| `tests/` | `run.mjs`为测试入口；保留core/input/output/models/scene/ui/server功能分组，不随src目录归组移动；fixtures、helpers、bench独立管理 |
| `docs/` | `JK_SOURCE.json`保存中央依赖入口；当前契约、使用、渲染、维护和托管文档集中于此，带日期证据位于validation |
| `dist/` | 可重新生成的client/server/hosting构建产物，不手动编辑 |

本地持久池保存于 `html/server/.data/model-pool.json`，首次读取时从种子创建；本地口令配置在 `html/server/.env`。这些运行数据不是可删除的示例或构建缓存。

## 界面维护边界

页面沿用原生 HTML/CSS、现有 JS 模块和 Vite，不引入模板语言或页面框架。

| 要改什么 | 修改位置 | 约定 |
| --- | --- | --- |
| 页面结构、固定控件和选项 | `html/index.html` | 按定位注释找到图片输入、输出渲染、模型管理或节点详情；固定面板保留在 DOM，通过 `hidden` 切换。R/G/B 控件分别写明。 |
| 变长行的结构 | `html/index.html` 的 `<template>` | 输出行、节点按钮、队列、历史、求值步骤、灯格、位序和模型选项使用模板；JS 克隆后填写 `textContent`、表单值和属性。 |
| 样式、配色、尺寸和窄屏适配 | `html/style.css` | 保持已有规则顺序和优先级；选择、异常和文字明暗使用 class。图片 Canvas 的绘图配色也在此定义，由控制器只读获取。 |
| 页面默认值与限制 | `html/config.js` 的 `APP_CONFIG` | 配置树递归冻结；图片输入、输出画板、播放、场景、列表与输入信号分别管理。可变状态复制对应分支。 |
| 交互和数据更新 | `html/main.js`、`src/ui/image-input-ui.js`、`src/ui/output-display-ui.js`、`src/ui/model-manager.js` | 绑定事件和填充模板；不得拼接 HTML、动态创建页面控件或通过 JS 写固定样式。图片处理由 `src/ui/` 负责，WebGPU 绘制由 `src/scene/` 负责。 |

JS 只写以下动态 CSS 变量：`--queue-row-height`、`--queue-total-height`、`--queue-scroll-offset`、`--lamp-columns`、`--lamp-rgb`。灯阵列宽度由 CSS 根据列数计算。队列保持每行 36px，只填充可见范围及少量缓冲行；历史显示最近 60 条。

默认图片选区 3×3；新画板 3×3、关闭、缩放 3 倍；布局 5D，播放 1 倍并跳过动画。页面与独立 Playback 共用默认值，批量灰度默认开启。旧版兼容分支已移除；模型仅接受 V4.0.0，画板 scale 必须显式提供。队列固定优先值归 `APP_CONFIG.engine.queues`，不是快照可修改配置。静态外观不放入 `APP_CONFIG`。

画板配置随 JK 快照保存于 `display.outputBoard`；`display.show` 保存布局。已应用画板同步至模型管理的 JSON 编辑器，通过模型管理统一下载；导入快照同时恢复画板，未带画板的快照使用上述统一默认值。画板结构校验复用 `src/ui/output-display.js` 的纯数据函数，供快照校验与服务端使用，不依赖 DOM 或 GPU。

两个弹窗控制器接收 HTML 中已有的根元素：`new ImageInputUI(root, onApply, onApplied)`、`new OutputDisplayUI(root, onApply)`。构造时绑定一次事件，关闭不移除静态 HTML，重新打开不追加监听。退出使用 `dispose()`，模型管理使用 `destroy()`；它们清理监听、观察器、请求、下载 URL 或临时图像资源。销毁后的根元素可以交给新控制器重新初始化。

下载复用 HTML 中预置的隐藏链接。图像解码、像素处理和 Canvas/WebGPU 绘制所需的临时画布允许由 JS 创建，它们不属于页面控件结构。

## 定向验证

根据实际改动选择相关测试，不默认执行全流程回归。用外部 Chrome 检查页面和交互；真实浏览器行为不能由假DOM/GPU测试替代。

支持通过统一入口调用 `tests/run.mjs`，选择分组或单个文件，命令会自动找到分组下的测试并传播退出码：

```sh
./tools/dev.sh test ui
./tools/dev.sh test input output
./tools/dev.sh test tests/scene/view.test.js
./tools/dev.sh test --list  # 只列文件，不运行
```

`pnpm run test ui` 等价于上述 `./tools/dev.sh test ui`。不带分组的 `./tools/dev.sh test` 会运行全部测试，只在明确需要全量回归时使用。`tools/dev.sh` 也可转发开发/预览参数，例如 `./tools/dev.sh dev --port 5180 --strictPort`。

```sh
# 示例：只检查静态HTML、默认配置与主界面更新
node --test tests/ui/ui-structure.test.js tests/ui/main-ui.test.js

# 示例：只检查图片输入及资源释放
node --test tests/input/*.test.js

# 示例：只检查模型池与服务端协议
node --test tests/models/model-pool.test.js tests/server/*.test.js
```

移动模块后除 import，还应核对 `new URL(..., import.meta.url)`、Worker路径、HTML资源、测试源码读取和文档链接。`./tools/dev.sh build` 后通过 `./tools/dev.sh preview` 检查模板、基础图片、图标和Worker资源。不得把已有历史“通过”数量当成本轮验证结果。

原UI重构的14文件/138项定向测试及外部Chrome范围记录在[2026-09-14验证记录](validation/ui-html-refactor.md)。该报告未运行全流程回归或性能基准。

### 目录调整验证（2026-10-12）

本轮针对 `html/`、`src/jk|ui|scene/`、`tools/`、`tests/run.mjs` 和 `docs/JK_SOURCE.json` 的迁移进行了以下验证：

```sh
./tools/dev.sh test core models input output ui
./tools/dev.sh test server scene/layout.test.js scene/node-tag-view.test.js scene/render-integration.test.js
./tools/dev.sh test tests/input/image-input-ui.test.js
./tools/dev.sh build
```

- 定向测试共覆盖216个不同用例。首次运行发现图片输入测试仍断言旧路径 `assets/images/b1.png`；修正为 `/b1.png` 后，该文件13项复跑全部通过，其余203项已通过。
- 前端和Sites Worker构建通过；`tools/dev.sh`在项目外目录调用仍能定位项目，Shell语法和`git diff --check`通过。模块相对引用和中央依赖索引路径已核对。
- 开发服务与生产预览的入口、示例、图片、图标和打包资源请求成功。开发服务拒绝读取 `html/server/` 下的服务端源码及环境文件；前端构建产物不包含该目录。
- 外部Chrome验证了示例加载与双指纹校验、暂停入队、单步和恢复执行、Yi输出、1D/5D布局、两张基础图片解码、非法JSON报错、合法JSON临时导入及输出画板配置。生产预览也完成了示例执行和两张打包图片加载，WebGPU已连接。
- 范围不包含全流程回归、性能基准、文件选择器和真实共享存储读写；服务端使用隔离数据验证。浏览器控制台仅观察到扩展脚本警告；构建仍提示主包超过500 kB。未提交Git或部署。

### 画板快照验证（2026-10-14）

`display.outputBoard` 的保存与恢复完成定向验证，共111项通过：`core/model-schema.test.js`、`output/model-export.test.js`、`models/model-pool.test.js`、`ui/main-ui.test.js`、`output/output-display-ui.test.js`、`models/model-manager.test.js`、`ui/ui-structure.test.js`及`server`分组；前端与Sites Worker构建通过。

外部Chrome实测画板窗口和模型管理下载的JSON均含完整快照及画板，重新导入恢复1×1画板、启用状态和红色亮度173；未应用草稿42未写入导出，scale=99的无效画板被拒绝。相关检查未运行全流程回归或真实共享存储写入，构建仍有原有主包大小提示。

### 画板 JSON 同步验证（2026-10-14）

移除输出渲染导出区域后，`models/model-manager.test.js`、`output/output-display-ui.test.js`、`ui/ui-structure.test.js`、`output/model-export.test.js`、`ui/main-ui.test.js`共68项相关测试通过，前端与Sites Worker构建通过。外部Chrome确认已应用画板直接进入模型管理JSON，重开窗口仍保留；亮度187已同步，未应用草稿42未写入，实际下载仍保留最新q与待执行任务。未运行全流程回归，未写入真实共享模型池。

## 有界渲染基准

基准源码仍位于 `tests/bench/render-benchmark.html`，在 Vite 的 `html/` 页面根目录之外。启动 `./tools/dev.sh` 后，在外部 Chrome 使用 `/@fs/` 加该文件的本机绝对路径访问。例如本机地址为 `http://127.0.0.1:5173/@fs/Users/cong/Desktop/VSCode/CODEX/ModelShow/tests/bench/render-benchmark.html`；更换项目位置时替换对应绝对路径，`/@fs/` 后不重复添加开头的 `/`。

它生成符合 V4 输入副本结构的768个JK、64个Xi、64个Yi（896个节点和2944条线），保留名称与次数，不执行逻辑事件。预热后记录120次RAF回调，并检查暂停后的60次RAF提交及手动渲染器恢复。性能结果只说明当前模型、分辨率和硬件；不能视为所有模型的帧率保证。普通目录整理无需运行该性能基准。

几何和纹理按所有权释放：不能释放Three.js全局共享Sprite几何。计数字形、合批实例与布局资源在相应模块维护；GPU恢复保留模型/队列/输出/计数和相机，计算保持暂停。

## 保留的参考资源

[早期界面 V1](images/image-V1.png)和[界面 V2](images/image-V2.png)保留在文档资源目录，仅作历史参考，不是当前浏览器验收截图。`node_modules/`、`dist/` 和包管理缓存由工具生成，不手工维护；本地环境文件和模型池运行数据独立保留。
