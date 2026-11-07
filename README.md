# ModelShow · JKRD7

ModelShow 是 JKRD7（7.0.0）模型的执行与网络展示工具。唯一规则来源为 [JK 中央项目的 JKRD7](../JK/JKRD7.md)，依赖入口见 [JK_SOURCE.json](docs/JK_SOURCE.json)。模型定义只接受新版 JKM，运行脚本、现场快照和 RGB 界面配置分别保存；不兼容、不迁移旧版本。

计算使用 JavaScript，也可选择 WebGPU 计算 EX。WebGPU 按 JKRD7 §7.5 提取可并行批，结果仍按规定的串行顺序提交；事务、通知和 FIFO 的语义不随计算平台改变。不使用 CUDA。页面与 3D 展示保留原来的 JK OBSERVATORY 样式、立方体节点、曲线和布局。网络场景使用 Three.js WebGPU；场景初始化失败时明确切换到 Canvas 2D。

顶栏 `header-center` 底部提供 **RGB / JKM** 标签，默认打开 JKM。JKM 保留当前模型、脚本和快照界面；RGB 恢复完整的原输入数据提取、输出渲染和模型管理布局。两个工作区有独立模型、运行状态和显示配置，切换时在完整处理单元结束后暂停当前工作区，返回时保留现场。

## 本地运行

需要 Node.js 22.12+ 与项目依赖。安装后启动开发服务：

```sh
pnpm install
./tools/dev.sh
```

在外部 Chrome 打开终端给出的本地地址，默认是 `http://127.0.0.1:5173/`。默认计算平台为 JavaScript；选择 WebGPU 后界面会报告其是否可用。

共享模型池是可选服务，在另一终端运行：

```sh
./tools/dev.sh api
```

构建与生产前端预览：

```sh
./tools/dev.sh build
./tools/dev.sh preview
```

`./tools/dev.sh serve` 提供已构建的前端和本地持久模型池。以上命令均不发布线上网站，详见[开发维护](docs/development.md)与[共享模型池](docs/hosting.md)。

## 功能

- 加载中央示例，导入、校验、编辑和下载 JKRD7 模型；无效导入保留当前有效模型。
- 通过输入入口发出通知，支持重叠输入批、单步、播放、暂停和恢复模型初值。
- 查看嵌套 JKS、JKI 的 q、trigger、sources、publish、all 到达记录，以及事件 FIFO、任务 FIFO 与登记轮。
- 按 `observe.watch` 订阅通知，按 `observe.read` 读取位；查看数值、字符与输出位画板。
- 执行独立运行脚本，保存和恢复独立现场快照，下载标准 JSONL 执行记录。
- JKM 可将图片灰度阈值结果映射到两个独热入口，生成逐像素运行脚本。
- RGB 保留原图片选区、RGB／灰度、像素／通道排列、字节位序和预设图片；提取完整 bit 数组后按显式绑定发送通知。
- RGB 输出支持通道与打包位编辑、批量绑定和原 3D 灯阵；绑定及灯阵另存 `.rgb.json`，不写入 JKM。
- 使用共享模型池；临时模型公开管理，永久模型操作继续要求管理员口令。

RGB 默认加载 `RGB_3X3`：216 位由 JKRD7 的 M_REG 结构组合保存，完成节点等待整帧后通知输出。3×3 灯阵已按 RGB 位绑定，沿用原默认关闭状态；在“输出渲染”中勾选“显示画板”即可显示。

当前支持单 queue。多个 queue 的调度、多 JKS 重复前置登记、工厂及生命周期行为仍遵守中央待定义边界，不根据旧版实现推断。

## 维护入口

| 内容 | 入口 |
| --- | --- |
| 模型、脚本、快照与执行边界 | [模型格式与执行](docs/model-format.md) |
| 页面操作 | [使用说明](docs/usage.md) |
| 场景和计算平台的区别 | [场景与渲染](docs/rendering.md) |
| 目录、配置和定向测试 | [开发维护](docs/development.md) |
| 本地池、Sites Worker 和 R2 | [共享模型池与托管](docs/hosting.md) |

验证截图、状态快照、过程报告、历史资料、备份和发布留档均放在系统临时目录，不作为项目内的永久文档入口。正式测试源码保留在 `tests/`，产品文档保留在 `docs/`；具体管理方式见[开发维护](docs/development.md#留档管理)。留档仍须保留原日期、协议版本、实际覆盖范围及未验证事项，不能据此推断全流程回归或硬件验证已经通过。

页面结构与模板写在 `html/index.html`，样式写在 `html/style.css`，产品默认值集中在 `html/config.js` 的只读 `APP_CONFIG` 树。JavaScript 绑定交互、填充模板及绘制 Canvas/GPU 图形，不拼接 HTML 或生成 CSS。

测试只运行本次改动相关功能；前端使用外部 Chrome 验收。Git 提交仍须先请求批准，说明理由并提供提交说明建议。本次本地更新不包含 Git 提交或线上发布。
