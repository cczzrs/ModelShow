# 开发与维护

[返回项目入口](../README.md) · [共享模型池与托管](hosting.md)

## 本地流程

使用 Node.js 22.12+ 与 pnpm。`pnpm install` 根据锁文件安装依赖。`./dev.sh` 优先使用系统 Node.js，缺少时尝试本机 Codex runtime；它不改变系统 Node 配置。

| 命令 | 用途 |
| --- | --- |
| `./dev.sh` | Vite 开发服务，默认 127.0.0.1:5173 |
| `./dev.sh api` | 本地模型池 API，默认 127.0.0.1:5174；可与开发服务同时运行 |
| `./dev.sh build` | 构建 Vite 前端和 Sites Worker |
| `./dev.sh preview` | 预览生产前端，沿用本地 API 代理；未连接 API 时支持本页导入和下载 |
| `./dev.sh serve` | 本地生产前端与共享模型池，默认 127.0.0.1:4173 |

修改开发源码后由 Vite 更新；生产预览需要重新构建。不要以 `file://` 打开入口，模块、Worker和WebGPU需要合适的浏览器上下文。页面前端资源本地打包，不使用远程CDN或字体。WebGPU不可用时显示明确提示，不回退WebGL。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `index.html` | 固定界面和原生模板 |
| `src/main.js` | 页面初始化、界面填充、帧循环和控制器协调 |
| `src/config.js` / `src/style.css` | 只读页面默认值 / 样式与响应式布局 |
| `src/core/` | 表达式解析、固定ID、FIFO、播放与帧尾刷新 |
| `src/input/` | 图片格式解码、像素提取、输入弹窗 |
| `src/output/` | Yi聚合/配置、输出弹窗、GPU灯阵列 |
| `src/models/` | 模型池纯数据与模型管理界面；纯数据模块同时供服务端使用 |
| `src/scene/` | WebGPU场景、布局及Worker、相机、合批、字形、曲线、全屏和资源 |
| `server/` | 本地HTTP服务、共用权限/版本服务、Sites Worker与R2适配 |
| `assets/` | 图片与图标，由 HTML 引用并经 Vite 打包 |
| `public/example.json` | 原模型池种子，本地静态预览仍可读取 |
| `scripts/` | 构建及项目维护入口 |
| `tests/` | 按core/input/output/models/scene/ui/server分组；fixtures、helpers、bench独立管理 |
| `docs/` | 当前契约、使用、渲染、维护和托管；带日期证据位于validation |
| `dist/` | 可重新生成的client/server/hosting构建产物，不手动编辑 |

本地持久池保存于 `server/.data/model-pool.json`，首次读取时从种子创建；本地口令配置在 `server/.env`。这些运行数据不是可删除的示例或构建缓存。

## 界面维护边界

页面沿用原生 HTML/CSS、现有 JS 模块和 Vite，不引入模板语言或页面框架。

| 要改什么 | 修改位置 | 约定 |
| --- | --- | --- |
| 页面结构、固定控件和选项 | `index.html` | 按定位注释找到图片输入、输出渲染、模型管理或节点详情；固定面板保留在 DOM，通过 `hidden` 切换。R/G/B 控件分别写明。 |
| 变长行的结构 | `index.html` 的 `<template>` | 输出行、节点按钮、队列、历史、求值步骤、灯格、位序和模型选项使用模板；JS 克隆后填写 `textContent`、表单值和属性。 |
| 样式、配色、尺寸和窄屏适配 | `src/style.css` | 保持已有规则顺序和优先级；选择、异常和文字明暗使用 class。图片 Canvas 的绘图配色也在此定义，由控制器只读获取。 |
| 页面默认值与限制 | `src/config.js` 的 `APP_CONFIG` | 配置树递归冻结；图片输入、输出画板、播放、场景、列表与输入信号分别管理。可变状态复制对应分支。 |
| 交互和数据更新 | `src/main.js`、`src/input/image-input-ui.js`、`src/output/output-display-ui.js`、`src/models/model-manager.js` | 绑定事件和填充模板；不得拼接 HTML、动态创建页面控件或通过 JS 写固定样式。图片处理、Canvas/WebGPU 绘制仍由原模块负责。 |

JS 只写以下动态 CSS 变量：`--queue-row-height`、`--queue-total-height`、`--queue-scroll-offset`、`--lamp-columns`、`--lamp-rgb`。灯阵列宽度由 CSS 根据列数计算。队列保持每行 36px，只填充可见范围及少量缓冲行；历史显示最近 60 条。

默认图片选区 3×3；新画板 3×3、关闭、缩放 3 倍；布局 4D，播放 1 倍并跳过动画。`outputBoard.compatibility.scale` 单独保留旧数据缺少 `scale` 时的 1 倍规则；业务 API 的批量灰度默认值和独立 `Playback` 的原有动画默认值也与页面默认分开，避免改变现有调用者。静态外观不放入 `APP_CONFIG`。

两个弹窗控制器接收 HTML 中已有的根元素：`new ImageInputUI(root, onApply, onApplied)`、`new OutputDisplayUI(root, onApply, onExport)`。构造时绑定一次事件，关闭不移除静态 HTML，重新打开不追加监听。退出使用 `dispose()`，模型管理使用 `destroy()`；它们清理监听、观察器、请求、下载 URL 或临时图像资源。销毁后的根元素可以交给新控制器重新初始化。

下载复用 HTML 中预置的隐藏链接。图像解码、像素处理和 Canvas/WebGPU 绘制所需的临时画布允许由 JS 创建，它们不属于页面控件结构。

## 定向验证

根据实际改动选择相关测试，不默认执行全流程回归。用外部 Chrome 检查页面和交互；真实浏览器行为不能由假DOM/GPU测试替代。

支持通过统一入口选择分组或单个文件，命令会自动找到分组下的测试并传播退出码：

```sh
./dev.sh test ui
./dev.sh test input output
./dev.sh test tests/scene/view.test.js
./dev.sh test --list  # 只列文件，不运行
```

`pnpm run test ui` 等价于上述 `./dev.sh test ui`。不带分组的 `./dev.sh test` 会运行全部测试，只在明确需要全量回归时使用。`dev.sh` 也可转发开发/预览参数，例如 `./dev.sh dev --port 5180 --strictPort`。

```sh
# 示例：只检查静态HTML、默认配置与主界面更新
node --test tests/ui/ui-structure.test.js tests/ui/main-ui.test.js

# 示例：只检查图片输入及资源释放
node --test tests/input/*.test.js

# 示例：只检查模型池与服务端协议
node --test tests/models/model-pool.test.js tests/server/*.test.js
```

移动模块后除 import，还应核对 `new URL(..., import.meta.url)`、Worker路径、HTML资源、测试源码读取和文档链接。`./dev.sh build` 后通过 `./dev.sh preview` 检查模板、基础图片、图标和Worker资源。不得把已有历史“通过”数量当成本轮验证结果。

原UI重构的14文件/138项定向测试及外部Chrome范围记录在[2026-09-14验证记录](validation/ui-html-refactor.md)。该报告未运行全流程回归或性能基准。

## 有界渲染基准

启动 `./dev.sh` 后在外部 Chrome 打开 `/tests/bench/render-benchmark.html`。它生成768个JK、64个Xi、64个Yi（896个节点和3136条线），保留名称与次数，不执行逻辑事件。预热后记录120次RAF回调，并检查暂停后的60次RAF提交及手动渲染器恢复。性能结果只说明当前模型、分辨率和硬件；不能视为所有模型的帧率保证。普通目录整理无需运行该性能基准。

几何和纹理按所有权释放：不能释放Three.js全局共享Sprite几何。计数字形、合批实例与布局资源在相应模块维护；GPU恢复保留模型/队列/输出/计数和相机，计算保持暂停。

## 保留的参考资源

[早期界面 V1](images/image-V1.png)和[界面 V2](images/image-V2.png)保留在文档资源目录，仅作历史参考，不是当前浏览器验收截图。`node_modules/`、`dist/` 和包管理缓存由工具生成，不手工维护；本地环境文件和模型池运行数据独立保留。
