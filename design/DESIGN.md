# Open Artifacts Workbench 设计系统

> 状态：Workbench 通用界面方向草案，供产品与架构 Review
>
> 适用范围：`design/index.html`、`design/instance.html` 与未来 Workbench 生产实现
>
> 最近复核：2026-07-30

本文件记录 Open Artifacts Workbench 的视觉意图、界面职责和交互规则。它不定义 Artifact
Package 的领域界面，也不替代 [`CONTEXT.md`](../CONTEXT.md)、产品模型或技术架构。

## 文档契约

1. 根目录 `CONTEXT.md` 定义 Package、Instance、Data、Annotation 与 Tool 的领域含义。
2. `docs/product.html` 定义 Human 与 Agent 要完成的产品流程。
3. `docs/architecture.html` 定义 Workbench、OA SDK、Agent Interface 与 Daemon 的责任关系。
4. 本文件定义 Workbench 的视觉语言、布局规则、交互状态和 Package UI 接入边界。
5. `tokens.css` 是当前共享设计 token 精确值的唯一真实来源。
6. `index.html` 是 Instance Manager 原型；`instance.html` 是单个 Instance Workbench 原型。两者都不是
   生产应用，也不自动构成新的产品需求。

## 设计命题

- **对象：** Open Artifacts 的 Instance Manager 与单 Instance Workbench。
- **用户：** 正在查看、选择、标注和验收 Artifact 的 Human。
- **单一任务：** 让 Human 始终知道自己正在操作哪个 Instance、指向哪段内容，以及 Agent
  的修改是否已经回到同一界面。
- **目标感受：** 像一张可靠的精密工作台：内容优先、状态明确、可追踪，但不把所有能力都做成控制面板。
- **视觉隐喻：** Manager 是工作目录，Workbench 是检视台。Artifact 位于主工作面，人的上下文与执行证据位于其左侧。
- **标志性元素：** **Context Trace**。一条琥珀色轨迹从 Artifact 中的当前目标延伸到左侧 Context
  Rail，表达“这条 Annotation 精确指向这里”。它是界面唯一的强装饰元素。

## 职责边界

```text
┌────────────────────────────── Workbench owns ──────────────────────────────┐
│ Instance identity · lifecycle · Package identity · Inspector · Annotation │
│ execution evidence · revision/sync status · global navigation             │
├────────────────────────────── Package owns ────────────────────────────────┤
│ Artifact UI · domain controls · domain selection · target presentation     │
│ domain data visualization                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Workbench 必须提供

- 当前 Instance 身份、Package Binding、Active / Stopped / Archived 状态。
- Package UI 的稳定承载区域，不覆盖或重排 Package 的领域控制。
- Pointer 与 Inspector 两种选取方式；Package Selection 优先，DOM Inspector 作为 fallback。
- 当前 Target 的结构化摘要、Annotation 输入、Annotation 列表和执行证据。
- Data revision、同步状态、Tool 数量和未解决 Annotation 数量。
- 键盘可访问的全局操作，例如切换 Inspector、返回 Instance Manager 和收起 Context Rail。

### Workbench 不负责

- 不把 Agent 做成必须存在的内置聊天框；Agent 通过统一 Agent Interface 工作。
- 不替 Package 设计领域 Tool、表单、时间线、图表或编辑器。
- 不直接编辑 Package Data，也不暴露 `instanceId`、`baseRevision` 或幂等键给 Package UI。
- 不把临时 hover、播放头、缩放和面板尺寸当成 Instance Data。
- 不把 Tool 成功等同于 Annotation resolved；必须显示 applied、验证和验收之间的差异。

## 布局

### Instance Manager

```text
┌──────────────────────────── Manager Bar ────────────────────────────────────┐
│ OA · Instance Manager                                      New instance    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Search · Active / Stopped / Archived                                      │
│ Instance              Package             Lifecycle    Annotation    Open   │
│ ...                                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Manager 负责创建、查找、筛选和打开 Instance。
- 生命周期管理属于 Manager；具体 Workbench 不再嵌套 Instance 列表。
- 点击 Open 进入独立 URL，并由该页面绑定一个确定的 Instance。

### 单 Instance 工作台

```text
┌──────────────────────────── Command Bar ────────────────────────────────────┐
│ ChatCut Editor · 1.4.0                                 Inspect · More       │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ Context Rail          │ Artifact Stage                                      │
│ Current Target        │ ┌──── Package-owned UI ───────────────────────────┐ │
│ Annotation composer   │ │                                                  │ │
│ Annotations / evidence│ │ Context Trace ─────────────● Artifact content    │ │
│ [‹ collapse]          │ └──────────────────────────────────────────────────┘ │
│                       │ [› Context]（Rail 收起后贴边悬浮）                    │
├───────────────────────┴──────────────────────────────────────────────────────┤
│ Active · Data synced · r18 · 6 Tools · 3 open Annotations                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Command Bar 固定在顶部；左侧只显示当前 Package 名称和版本，右侧只放跨 Artifact 的操作。
- Context Rail 默认位于左侧且宽 `360px`，只展示当前 Target 和与它相关的沟通记录；Human
  可以随时收起，让 Artifact Stage 占满空间。
- Rail 收起后，在 Artifact Stage 左缘保留带文字的 `Context` 悬浮把手；它不占布局宽度，展开
  Rail 后消失。键盘焦点在收起按钮与悬浮把手之间交接。
- Artifact Stage 获得剩余空间；Package UI 外只保留一层低对比度边界。
- Status Strip 固定在底部，显示权威状态，不重复业务内容。

### 窄屏

- 小于等于 `1080px` 时 Context Rail 变为从左侧打开的临时抽屉，默认收起。
- 抽屉内部提供明确的收起按钮；收起后只通过工作区左缘的 `Context` 悬浮把手重新展开，
  不在 Command Bar 重复放置开关。
- Package UI 可以水平滚动，但 Workbench 自身不得造成页面级横向溢出。
- Inspector、Annotation 和菜单触控目标不得小于 `44 × 44px`。

## 颜色

精确色值只维护在 `tokens.css`；本节描述语义职责。

- **Graphite：** Command Bar、主要文字和高置信度结构。
- **Fog：** Workbench 背景，区分 OA 外壳与 Package UI。
- **Porcelain：** Artifact Stage、Rail 与浮层表面。
- **Signal Blue：** Inspector、焦点、Agent Interface 与主操作。
- **Context Amber：** Selection、Annotation、Context Trace 和需要 Human 判断的内容。
- **Data Green：** committed、synced、Active 和可验证的成功状态。
- **Package Violet：** Package 身份与 Package-owned 区域标签，不用于通用主按钮。

状态不能只依赖颜色；文本、图标、轮廓或位置至少再提供一种差异。

## 排版

- **界面标题：** `Avenir Next` / `SF Pro Display`，只用于 Instance 名称和主要区域标题。
- **正文与控件：** `Inter` / `SF Pro Text` / `PingFang SC`，保证长时间操作的可读性。
- **状态与技术信息：** `SFMono-Regular` / `Roboto Mono`，用于 revision、Package 版本、时间码和 Tool 名称。

Workbench 使用紧凑但不拥挤的密度。界面层级主要来自字重、列宽和留白；阴影只用于 Composer、
菜单和真正覆盖内容的浮层。

## 核心组件

### Command Bar

- 左侧只显示当前 Package 名称和版本，不放 OA 品牌、Instance breadcrumb、Instance 名称或
  lifecycle。
- 右侧放 Inspector 与全局操作，不放 Package 的领域按钮。
- Active、Stopped、Archived 移到 Status Strip，并同时使用文字和状态图形。

### Instance Manager List

- 每一项展示名称、Package、生命周期和未解决 Annotation 数量。
- 每一项提供明确的 Open 行为，进入独立 Instance Workbench。
- 搜索与 lifecycle 筛选属于 Manager，不出现在具体 Instance 页面。

### Artifact Stage

- Workbench 只提供容器、加载、错误、停止和归档状态。
- Package-owned 区域使用一条低强度虚线标签，不在正常使用时持续显示开发者边界。
- Selection 优先使用 Package Target Presentation；没有 Provider 时才显示 Inspector DOM 路径。

### Context Rail

- 一级标签只使用 `Current Target` 与 `Annotations`。Agent 回复、Tool evidence 和 Human
  验收状态嵌套在所属 Annotation 内，不建立独立聊天 Thread。
- Composer 在有 Target 时附带 Target Chip；没有 Target 时明确提示 Annotation 将附着于整个 Artifact。
- OA 在创建 Annotation 时自动保存结构化 Target Snapshot。`Attach screenshot` 只添加当前
  Artifact 画面的可选视觉证据，不参与定位，也不替代 Target Snapshot。
- Agent 回复与 Human 消息使用角色、时间和状态区分，不模拟社交聊天气泡。
- Inspector fallback 的限制集中显示在 Artifact 顶部状态条，不在 Composer 下方重复展示说明卡。

### Context Trace

- 只在存在当前 Target、Context Rail 可见且 `Current Target` 标签打开时显示。
- 起点贴近 Target outline，终点落在 Current Target 标题，不穿过关键内容。
- 窄屏和 `prefers-reduced-motion` 下退化为 Target Chip，不绘制跨区域连线。

### Status Strip

- 只显示可核验状态：Instance lifecycle、Data sync/revision、Tool count、Annotation count。
- 错误状态说明发生了什么和下一步；不使用只有颜色的红点。

## 关键交互状态

### Default

Human 浏览并操作 Package UI；Context Rail 展示当前 Target 或 Annotation，不强迫先选择目标。

### Inspect

Workbench 显示可聚焦的目标轮廓。Package Target 优先；DOM Inspector fallback 必须明确标注来源。
`Escape` 退出 Inspector，不能依赖再次点击同一按钮。

- Inspector 顶部状态条必须说明它只保存 DOM evidence；Agent 执行前仍需由 Package
  重新定位 Target。
- 普通点击用一个 Target 替换当前 Selection；按住 `⌘`（macOS）或 `Ctrl`（Windows / Linux）
  点击则添加或移除 Target。
- 多选仍然生成一个 Selection，其中包含有序 Target 列表；提交时形成一条 Annotation，而不是按
  Target 拆成多条 Annotation。
- Workbench 为已选 Target 显示顺序编号，并在 Context 中展示数量、selector 列表和来源。Context
  Trace 只连接最近一次操作的主 Target，避免多条跨区域连线遮挡 Artifact。

### Target selected

Context Trace 出现，Context Rail 更新为同一 Target 的 Presentation。Selection 是临时交互状态；
只有 Human 提交 Annotation 后才生成 Target Snapshot。

### Annotation open

Workbench 展示 Annotation body、Target Snapshot 摘要和 change status。Agent 尚未执行时不得显示成功。

### Applied / resolved

- `applied`：Tool 已提交 Data revision，并附有 callId 与结果证据。
- `resolved`：Agent 已回读验证，或 Human 已验收。
- `rejected`：Human 拒绝 Proposal，Data revision 不变。

### Stopped / archived

- Stopped：保留 Data 与 Annotation，Artifact Stage 显示“启动 Instance”。
- Archived：只提供 Restore，不提供 Tool 调用或直接启动。

## 动效

- Context Trace 在 Target 改变时使用一次 `220ms` 的路径过渡。
- Rail 切换和 Composer 展开使用 `160–240ms`，不使用弹簧或持续呼吸动画。
- Data revision 更新时只闪现一次同步提示，不让整页内容位移。
- `prefers-reduced-motion` 下取消 Trace 绘制动画和面板位移。

## 无障碍基线

- 所有 Workbench 操作支持键盘和清晰的 `:focus-visible`。
- Artifact Stage 与 Context Rail 使用独立地标和可理解标题。
- Inspector 必须提供非指针替代方式，例如通过 Tab 遍历可选 Target。
- Context Trace 只承担视觉关联；读屏通过 `aria-describedby` 获得相同 Target 关系。
- 文本放大到 `200%` 时仍能完成选择、提交 Annotation 和查看状态。
- 原型必须检查一个桌面宽度、一个窄屏宽度、键盘操作和减少动态效果。

## 当前原型

`index.html` 展示独立 Instance Manager；`instance.html` 使用 ChatCut 风格的视频时间线与 Markdown
编辑器作为 Active Package UI 示例，并补充 Stopped、Archived 两种运行状态，以验证：

1. 从 Manager 打开一个确定的 Instance，并进入独立 URL；
2. 清楚区分 Workbench-owned 与 Package-owned 区域；
3. 在 Package 自定义 Target 与 Inspector fallback 之间切换；
4. 把左侧 Context Rail、选中目标、Annotation composer 和执行证据组织在一起；
5. 在不内置 Agent 聊天框的情况下展示 Agent 结果；
6. 在窄屏保持可理解的阅读顺序。

原型中的项目名、时间码、Tool 数量和 revision 都是设计样例，不代表运行时已经实现。

## 待确认

- Context Rail 默认显示 Current Target，还是上次打开的标签。
- Workbench 是否需要独立 Activity 视图，还是只在 Annotation 内展示 Tool evidence。
- Package 能否请求全屏沉浸模式，以及退出全屏后如何恢复 Context Rail。
- 多个并发 Agent 的 actor 展示和 Human approval 入口。
