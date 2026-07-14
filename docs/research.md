# Open Artifacts CLI：开源产品与技术版图

> 调研日期：2026-07-14  
> 研究问题：开源社区是否已经存在一个工具，能通过 CLI 下载可执行的 Artifact Package、在本地启动 Web Server、打开浏览器，并让用户或 Agent fork 源码？  
> 方法：仅采用项目官方仓库、官方文档和 npm Registry 等一手资料。项目自述只用于确认其公开能力，不代表对成熟度或安全性的独立背书。

## 结论

没有发现一个开源项目完整覆盖以下闭环：

```text
版本化源码 Package
    -> CLI 下载与缓存
    -> 本地启动 Server
    -> 人或 Agent 打开浏览器
    -> 原地运行
    -> 一条命令 Fork 成可编辑源码
```

最接近的直接竞品是 [Claude Artifact Runner](https://github.com/claudio-silva/claude-artifact-runner)。它已经实现 `npx` 运行单个 React Artifact、启动 Vite、自动打开浏览器，以及把 Artifact 转成完整可编辑项目；但它消费的是单个 `.tsx/.jsx` 文件和固定模板，没有版本化 Artifact Package、Package 自有依赖、Input Schema、Registry 或 Agent-neutral 接口。

Open Artifacts 的市场机会不是重新发明其中任何一个零件，而是组合四个已经被分别验证的模式：

1. Claude Artifact Runner 的一条命令运行体验；
2. shadcn Registry 的源码分发与用户所有权；
3. npm 的版本、依赖、缓存与完整性机制；
4. MCP Apps 的 Agent/Host 互操作方式。

可以将差异化压缩成：

> **Claude Artifact Runner 的运行体验 × shadcn 的源码所有权 × npm 的版本分发 × MCP Apps 的 Agent 互操作。**

## 目标能力拆解

为了避免把“相似”说得过宽，本次调研把目标拆成六项可观察能力：

| 能力    | 含义                                               |
| ------- | -------------------------------------------------- |
| Package | Artifact 是带 manifest、源码、依赖和版本的分发单位 |
| Resolve | CLI 能从 Registry、URL 或本地路径解析并取得它      |
| Run     | CLI 能启动所需的本地 Web Runtime                   |
| Open    | CLI 或 Agent Adapter 能把运行地址交给浏览器        |
| Agent   | Coding Agent 能稳定调用，并获得机器可读的运行结果  |
| Fork    | 用户获得完整源码，可在本地修改、重命名和继续发布   |

## 对比矩阵

| 项目                                                                                                              | Package / 分发单位                          | CLI 下载           | 本地 Server + 浏览器 | Agent 原生       | 源码 Fork              | 与 Open Artifacts 的关系        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------ | -------------------- | ---------------- | ---------------------- | ------------------------------- |
| [Claude Artifact Runner](https://github.com/claudio-silva/claude-artifact-runner)                                 | 单个 `.tsx/.jsx` + 固定项目模板             | 部分               | **是**               | 否               | `create` 生成完整项目  | 最接近的直接竞品                |
| [IBM mcp-cli](https://github.com/IBM/mcp-cli) + [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)      | MCP Tool 引用的 `ui://` HTML Resource       | 由 MCP Server 提供 | **是**               | **是**           | 否                     | 最接近 Agent 调用与浏览器交付   |
| [shadcn Registry](https://ui.shadcn.com/docs/registry)                                                            | Registry Item 中的源码、依赖与配置          | **是**             | 否                   | 可由 Agent 调用  | **是**                 | `oa fork` 最重要的源码分发先例  |
| [Open Design](https://github.com/nexu-io/open-design)                                                             | Artifact、Plugin、Skill、Design System      | 部分               | **是**               | **是**           | HTML/CSS 可交接        | 更宽的 Agent-native 设计工作台  |
| [OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI)                                                | Agent 每次生成的 HTML/SVG/JS                | 否                 | 项目级开发服务       | **是**           | 只能 fork 整个项目     | “每次生成 UI”路线的代表         |
| [A2UI](https://github.com/a2ui-project/a2ui)                                                                      | 可更新的声明式 JSON UI 消息                 | 否                 | 由宿主负责           | **是**           | 否                     | 跨信任边界的 UI 格式路线        |
| [json-render](https://github.com/vercel-labs/json-render)                                                         | Catalog + JSON UI Tree + Renderer Libraries | npm Libraries      | 由宿主负责           | **是**           | Registry 属于宿主源码  | 结构化 Generative UI 路线的代表 |
| [Storybook](https://storybook.js.org/docs)                                                                        | Component + Story                           | 初始化项目         | **是**               | Agent 可辅助使用 | 组件源码本来就在项目内 | 隔离预览与 Workbench 体验先例   |
| [Observable Framework](https://observablehq.com/framework/getting-started)                                        | 完整 Markdown/JS Data App                   | 创建项目           | **是**               | 否               | **是**                 | Source-first Data App CLI 邻居  |
| [marimo](https://docs.marimo.io/) / [Streamlit](https://docs.streamlit.io/get-started/fundamentals/main-concepts) | Python Notebook 或 App 文件                 | 否                 | **是**               | 否               | 通过文件/Git           | CLI 启动本地交互页面的成熟模式  |

## 最接近的直接竞品

### Claude Artifact Runner

[Claude Artifact Runner](https://github.com/claudio-silva/claude-artifact-runner) 是当前最接近目标工作流的开源项目：

- `npx run-claude-artifact my-app.tsx` 会准备 React/Vite 环境、启动开发服务器并打开浏览器；
- `build` 可以生成单文件或多文件部署结果；
- `view` 可以为构建结果启动临时服务器；
- `create` 可以把单个 Artifact 转成完整可编辑项目，甚至初始化 Git Remote；
- 项目以 MIT License 发布。

它已经证明“一条 CLI 命令把 AI 生成的 React 文件变成可运行网页”是成立的用户体验。Open Artifacts 不能把“起 Vite + 开浏览器”本身当作独特性。

关键差异在分发单位：Claude Artifact Runner 把 Artifact 看作一个需要被固定模板承载的 TSX 文件；Open Artifacts 希望把它看作一个普通 npm 源码包，Package 自己拥有组件树、样式、Schema、Example 和第三方依赖。这使不同 Artifact 可以有不同依赖和输入合同，也使版本、缓存、更新与 Fork 有统一语义。

## Agent 与浏览器交付的直接先例

### IBM mcp-cli + MCP Apps

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 规定 MCP Tool 可以声明一个 `ui://` HTML Resource；Host 获取资源后在 sandboxed iframe 中展示，并通过消息协议向 UI 传递 Tool Result，UI 也可以反向调用工具。

[IBM mcp-cli](https://github.com/IBM/mcp-cli/blob/main/README.md#mcp-apps-interactive-browser-uis) 已经把这个协议做成终端体验：调用带 UI metadata 的工具后，它会取得 UI Resource、启动本地 Web Server、自动打开浏览器，并用 WebSocket 连接 MCP Server。

这说明“Agent 触发 → 本地 Server → 浏览器 UI”并不是空白。Open Artifacts 的差异应当是：

- MCP Apps 分发的是 Tool 关联的 HTML Resource；
- Open Artifacts 分发的是可独立运行、版本化和 fork 的源码 Package；
- MCP Apps 解决 UI 如何进入 Agent Host；
- `oa` 解决源码 UI Package 如何取得、运行、检查和演化。

两者更适合兼容，而不是互相替代。未来 `oa` 可以为 Artifact Package 提供 MCP App Adapter，但没有必要再设计一套 Host ↔ iframe 通信协议。

## 源码分发的核心先例

### shadcn Registry

[shadcn CLI](https://ui.shadcn.com/docs/cli) 的 `add` 命令可以从名字、URL 或本地路径取得 Registry Item，把组件源码和依赖写进用户项目，并提供 `--dry-run`、`--diff` 和 `--view` 检查安装内容。[Registry 文档](https://ui.shadcn.com/docs/registry) 还允许第三方发布自己的组件、Block、Hook、页面和配置。

这是 `oa fork` 最值得借鉴的模型：Fork 不应只等于 `git fork`，而应当是一次可审计的源码物化过程：

```text
解析 Package
    -> 展示即将写入的源码和依赖
    -> 复制到用户目录
    -> 重写本地 Package Identity
    -> 保留 upstream / integrity / version 来源
    -> 安装依赖
```

Open Artifacts 比 shadcn 多出的部分，是 Registry Item 本身可以直接运行成一个完整页面，而不是先嵌入另一个应用才能看到结果。

## Agent-native 产品邻居

### Open Design

[Open Design](https://github.com/nexu-io/open-design) 是一个 local-first 的开源设计工作台，能调用用户机器上已有的 Codex、Claude Code、Cursor、OpenCode 等 Coding Agent，生成 HTML Artifact 并在本地 sandboxed iframe 中预览。它还提供 CLI、MCP Server、Plugin、Skill 和 Design System，并通过 `od mcp install <agent>` 接入多种 Agent。

它验证了两个重要判断：

1. 不必把模型内置到产品里，可以把用户已经安装的 Coding Agent 当作生成引擎；
2. Artifact Runtime、Agent Adapter 和创作工作台可以分层。

Open Design 的范围是完整设计生产工作流；Open Artifacts 如果也走向技能市场、设计系统、模型选择、生成工作台和导出套件，会正面进入更重的产品竞争。`oa` 更适合保持为底层、小而稳定的 Package Runtime。

### OpenGenerativeUI、A2UI 与 json-render

[OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) 让 Agent 每次生成 HTML/SVG/JS，再放入 iframe；[A2UI](https://github.com/a2ui-project/a2ui) 定义可更新的声明式 JSON UI 消息，由宿主使用自己的组件库渲染；[json-render](https://github.com/vercel-labs/json-render) 则让模型在预先定义的 Component Catalog 内生成可流式传输的 JSON UI Tree。

它们代表两个常见方向：

- 每次即时生成任意 UI，表达力高但复用、版本和一致性弱；
- 每次生成结构化 UI Spec，安全和可预测性高，但表达能力受宿主 Renderer 或 Catalog 限制。

Open Artifacts 不应成为第三种 UI DSL。它的不同选择是：完整 React Package 定义表达能力，Agent 日常只填 Package 自己的 Input JSON；当表达能力不足时，再 fork Package 源码。这样把稳定路径和代码逃生路径放在同一个分发模型中。

## Runtime 与 Workbench 邻居

- [Storybook](https://storybook.js.org/docs) 证明了 `CLI + 本地 Server + 浏览器 Workbench + 隔离状态` 的前端开发体验，但 Story 是现有组件的开发夹具，不是可下载的 Agent Artifact。
- [Observable Framework](https://observablehq.com/framework/getting-started) 是 source-first 的 Data App CLI，提供项目创建、实时本地预览和静态构建，但分发单位是完整数据应用，不是可复用 Artifact Package。
- [marimo](https://docs.marimo.io/) 可以把纯 Python Notebook 作为 Web App 运行，并提供 watch、远程文件和 sandbox 等运行方式；[Streamlit](https://docs.streamlit.io/get-started/fundamentals/main-concepts) 的 `streamlit run` 也会启动本地 Server 并打开浏览器。它们证明 CLI 是交互内容最自然的本地 Runtime 入口。
- [Sandpack](https://github.com/codesandbox/sandpack) 提供浏览器内可编辑的代码运行环境，可作为未来 Web Workbench 的底座，但它不定义 Package、CLI 或 Fork；v0 使用本地 Node/Vite 会更简单。

## 名称与命令冲突

社区已经存在一个名为 [OpenArtifacts](https://mayfer.github.io/open-artifacts/) 的 Claude Artifacts 开源克隆。它在浏览器里用 `esbuild-wasm` 打包生成代码，并通过 CDN 解析依赖，还能导出单 HTML 文件。它与当前项目的 Package/CLI 路线不同，但会造成搜索、品牌和仓库命名混淆。

npm 上的非 scoped 包名 [`oa`](https://www.npmjs.com/package/oa) 也已被其他项目占用。当前可行的分发方式是发布 scoped package，例如：

```bash
npx @open-artifacts/cli run @open-artifacts/decision-board
```

其中 `@open-artifacts/cli` 仍然可以在 `package.json.bin` 中暴露本地命令名 `oa`：

```bash
npm install -g @open-artifacts/cli
oa run @open-artifacts/decision-board
```

在正式发布前，应单独完成 npm scope、GitHub Organization、域名、商标与搜索可发现性的检查。

## 市场空位

现有项目分别覆盖了目标链路中的一段，但没有发现完整组合：

| 已被验证的能力             | 代表项目               |
| -------------------------- | ---------------------- |
| 单命令运行 React Artifact  | Claude Artifact Runner |
| 源码 Registry 与本地所有权 | shadcn                 |
| Agent 触发浏览器 UI        | MCP Apps + IBM mcp-cli |
| Agent-neutral 本地创作环境 | Open Design            |
| 隔离 UI Workbench          | Storybook              |
| 结构化 Generative UI       | A2UI / json-render     |

Open Artifacts 可以占据的不是“AI 生成 UI”这一宽泛类别，而是更窄的基础设施层：

> **面向 Coding Agent 的、source-first、package-native Artifact Runtime。**

它承诺：任何 Agent 都可以用同一个 `oa` 命令，把一个可审计、可复现、可 fork 的源码 Artifact 交给用户，而不要求用户先进入某个在线 IDE、聊天产品或特定模型平台。

## 对产品设计的直接启示

1. `oa run` 必须是一等入口；Workbench 是它启动的 Runtime UI，不是产品的上层首页。
2. `oa fork` 应借鉴 shadcn 的 `view`、`dry-run`、`diff` 和来源记录，而不是只做目录复制。
3. Agent 集成应通过稳定的 stdout JSON、Agent Skill 或 MCP Adapter 完成，不应把某一种 Agent SDK 写进 Package 格式。
4. Package 格式应继续复用 npm；首版没有必要自建 Registry。
5. “任意源码执行”必须明确可信边界；本地优先不等于天然安全。
6. 不应同时做模型编排、在线 IDE、Generative UI DSL、协作平台和部署平台。

## 最终判断

这个方向值得继续，但定位必须从“更好的 AI 网页”收窄为“AI Artifact 的本地 Package Runtime”。如果 `oa` 只启动 Vite，它会被 Claude Artifact Runner 覆盖；如果只把 JSON 变成 React，它会进入 json-render/A2UI 的范围；如果做完整设计工作台，它会进入 Open Design 的范围。

真正需要验证的独特闭环是：

```text
oa run <package>
    -> 可复现地运行
    -> Agent 能打开并检查
    -> oa fork <package>
    -> 用户真正拥有源码
    -> fork 后仍然是可分发 Package
```
