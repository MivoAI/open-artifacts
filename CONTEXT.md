# Open Artifacts

Open Artifacts 是面向 Artifact Package 的本地优先运行与协作基建。OA 从 Package 创建持久化的
Artifact Instance，让人通过 Artifact UI 理解和编辑内容，让外部 Agent 通过 Data、Annotation
与 Tool 三项能力读取上下文并执行工作。

## Artifact 语言

```text
[Artifact]
    |
    +--静态形态--> [Artifact Package]
    |
    +--运行时形态--> [Artifact Instance]

[Artifact Reference] --解析为--> [Artifact Package]
                                          |
                     +--------------------+--------------------+
                     |                    |                    |
             [Artifact Source]    [Input Contract]      [Example Input]

[Input Contract] --校验--> [Artifact Input]
[Example Input] --是一种--> [Artifact Input]

[Artifact Package] + [Artifact Input] --创建--> [Artifact Instance]
```

**Artifact**：
人和 Agent 共同理解、操作和维护的网页产物概念。静态时表现为 Artifact Package，运行时表现为
Artifact Instance；Artifact 不是 Package 与 Instance 之外的第三种实体。
_避免使用_：仅指 Artifact UI、仅指构建产物、Package 之上的容器

**Artifact Package**：
Artifact 的静态形态，是一个有版本、发布源码的可复用定义，声明 Artifact UI、可接受的初始输入
以及 Artifact Tool。
_避免使用_：模板、插件、生成页面、Artifact Instance

**Artifact Reference**：
用于解析 Artifact Package 的值，例如包标识或本地源码位置。
_避免使用_：Artifact ID、Package URL（当它们不能覆盖所有引用形式时）

**Artifact Source**：
Artifact Package 中可由开发者或 Agent 继续维护的源代码。
_避免使用_：构建产物、bundle、生成网站

**Artifact Input**：
创建 Artifact Instance 时交给 Package 的 JSON 兼容初始数据；创建完成后，持续变化的工作内容属于
Instance Data。
_避免使用_：props、请求 payload、Instance Data

**Input Contract**：
由 Package 声明的 Artifact Input 有效范围，定义 Package 与 Instance 创建过程之间的数据约定。
_避免使用_：组件 props、Data API

**Example Input**：
Package 在未提供其他输入时使用的一份 Artifact Input，使 Package 可以被立即实例化和查看。
_避免使用_：mock data、测试数据、Instance Data

## Instance 语言

```text
[Artifact Package] + [Artifact Input]
                  |
            instantiate
                  |
                  v
       [Artifact Instance: Stopped]
              |             ^
         start|             |stop
              v             |
       [Artifact Instance: Active] --由--> [Artifact Runtime] --提供--> [Artifact UI]

[Stopped Instance] --archive--> [Archived Instance]
[Archived Instance] --restore--> [Stopped Instance]

[Artifact Instance] --replace Package Binding--> [同一个 Artifact Instance]
        |                                              |
        +---- Instance ID / Data / Annotations 不变 ---+

[Artifact Instance] --持久化于--> [Instance Bundle]
[Instance Bundle] --默认位于--> [OA Home]
[Instance Bundle] --可迁移到--> [User-managed Location]
[OA] --登记 Instance ID 与当前位置--> [Instance Registration]
```

**Artifact Instance**：
Artifact 的运行时形态，是从一个确定版本的 Artifact Package 创建出来的、可寻址且持久化的工作实体。
它持久化在一个可移动的 Instance Bundle 中，并保留自己的身份、Instance Data、Annotations 与当前
Package Binding。
_避免使用_：Artifact Session、Runtime Instance、Render、项目进程

**Package Binding**：
Artifact Instance 当前使用的 Artifact Package Reference 与精确版本。替换 Package Binding
不会创建新的 Instance；Instance ID、Instance Data 与 Annotations 保持不变，下一次启动的 Runtime
使用新的 Package。
_避免使用_：Instance Fork、Runtime Restart、复制 Instance、Artifact Reference

**Instance ID**：
一个 Artifact Instance 的本地唯一身份；在 Active、Stopped 与 Archived 三种状态间保持不变。
_避免使用_：Session ID、Artifact ID、进程 ID

**Instance Bundle**：
一个 Artifact Instance 的可移动持久化载体；它以 `<name>.openartifact` 目录包保存 Instance 身份、
Data、Annotations、Bindings 与 Package Binding，其位置变化不会改变 Instance。
_避免使用_：Artifact Package、Session 目录、导出压缩包、OA 缓存

**Instance Registration**：
OA 在本机保存的 Instance ID 与当前 Instance Bundle 位置之间的关联。它只负责重新找到 Bundle，
不复制 Bundle 内容，也不成为第二份权威数据。
_避免使用_：Package Binding、Instance 副本、备份、数据所有权

**OA Home**：
OA 在本机管理默认 Instance Bundles 与运行支持数据的位置。Bundle 迁出后，OA Home 只保留找到该
Bundle 所需的 Instance Registration 和短生命周期运行数据。
_避免使用_：用户工程、Instance Bundle、数据备份

**Instance URL**：
Active Instance 对外提供 Artifact UI 时使用的浏览器地址。
_避免使用_：Session URL、Package URL、源码地址

**Active Instance**：
Artifact Runtime 正在运行，并对外提供 Artifact UI 与 Artifact Tools 的 Instance。
_避免使用_：运行进程、打开的标签页、Session

**Stopped Instance**：
Artifact Runtime 已停止，但身份、Instance Data 与 Annotations 仍然保留并可再次启动的 Instance。
_避免使用_：已删除 Instance、关闭的标签页、失败状态

**Archived Instance**：
已经归档、仍可恢复，但必须先恢复为 Stopped 才能再次启动的 Instance。
_避免使用_：已删除 Instance、Stopped Instance、备份文件

**Artifact Runtime**：
为一个 Active Instance 提供 Artifact UI 并运行其 Package 能力的短生命周期执行环境；停止 Runtime
不会删除 Artifact Instance。
_避免使用_：Artifact Instance、Runtime Instance、Session Runtime

**Artifact UI**：
由 Package 定义、在 Active Instance 中呈现的可交互界面，是 Instance Data 的可视化和人的操作面。
_避免使用_：Artifact Instance、静态截图、Workbench

**Workbench**：
OA 提供的浏览器外壳，在 Artifact UI 之外承载 Annotation 线程和默认 DOM Inspector。
_避免使用_：Artifact UI、Artifact Package、Agent 执行器

## Instance 能力

```text
运行时 Artifact：
[Artifact UI / Tool Handler] --使用注入的--> [OA SDK] --> [Data Authority]

外部 Agent 的默认路径：
[External Agent] --> [OA CLI] --> [Tool API] --> [Artifact Tool]
                                                    |
                                                 [OA SDK]
                                                    |
                                                    v
                                             [Data Authority]

外部 Agent 的降级路径：
[External Agent] --> [OA CLI] --仅在 Tool 能力不足时--> [Data API] --> [Data Authority]

[Human] --通过 Artifact UI--> [Instance Data]
[Human] --通过 Workbench----> [Annotations]
[External Agent] --通过 OA CLI 读取 / 回复--> [Annotation API]
```

**Instance Data**：
一个 Artifact Instance 的持久工作内容，可以由 OA 管理，也可以通过 Data Binding 指向外部资源。
_避免使用_：UI State、Public State、Annotation、Artifact Input

**Data Binding**：
Instance 与外部本地文件或线上数据源之间的持久引用关系；它允许 Instance 使用数据而不必复制数据本体。
_避免使用_：附件副本、Annotation Target、临时 URL

**Data API**：
OA 对 Instance Data 定义的读取与修改语义。运行时 Artifact 通过注入的 OA SDK 使用它；外部 Agent
只在 Artifact Tool 能力不足时，才通过 OA CLI 直接使用它。两种通道最终进入同一个 Data Authority，
所有成功写入遵守相同的数据校验、提交与 revision 语义。
_避免使用_：Tool API、Annotation API、任意宿主文件系统权限

**OA SDK**：
OA 注入 Artifact Runtime 的程序化 API。Artifact UI 与 Tool Handler 使用它读写当前 Instance 的
Data，并访问运行时需要的 Annotation 等能力。Runtime 已经限定了当前 Instance，因此 Package
调用 OA SDK 时不传 instanceId；外部 Agent 不直接使用 OA SDK。
_避免使用_：Agent API、Package 自建 Data API、协议 Adapter

**SDK Data Binding**：
OA SDK 为 Artifact UI 提供的开箱即用绑定关系，使 UI 能读取当前 Instance Data、提交修改，并在
权威 Data revision 变化后收敛到最新状态。它是 SDK 必须提供的能力，不预先限定使用事件流、轮询、
Signals、React Context 或其他工程机制。
_避免使用_：Data Binding、组件本地 State、固定前端框架实现

**OA CLI**：
OA 面向外部 Agent 与本地自动化提供的命令行入口。Agent 默认通过它发现并调用 Artifact Tool；
只有 Tool 能力不足时，才通过它直接读写 Instance Data。CLI 与 OA SDK 共享同一组底层语义和
Data Authority，但服务于不同调用方。外部 Agent 的请求必须显式指定 instanceId。
_避免使用_：运行时 Artifact SDK、第二套业务语义、任意宿主文件系统访问

## 运行时角色

**Human**：
通过 Artifact UI 理解和编辑 Artifact，通过 Workbench 创建 Annotation，并验收修改结果；必要时确认
高风险操作。Human 不需要理解 OA CLI、OA SDK 或底层文件布局。

**External Agent**：
通过 OA CLI 访问目标 Artifact Instance。默认发现并调用 Artifact Tool；读取或回复 Annotation；
只有 Tool 能力不足时才直接读写 Instance Data，并可观察 Artifact UI 验证结果。

**OA**：
管理 Artifact Instance 的身份与生命周期，注入 OA SDK，提供 OA CLI、Data Authority、Annotation、
Tool 路由与 DOM Inspector fallback。OA 不解释 Package 的领域语义。

Artifact、Artifact Package 与 Artifact Instance 是协作对象及其形态，不是运行时角色。

## Annotation 语言

```text
[Human] --指出--> [Selection：抽象规则]
                            |
            +---------------+---------------+
            |                               |
            v                               v
 [Artifact Package]              [DOM Inspector fallback]
            |                               |
            +-----------描述----------------+
                            |
                            v
                  [Target Descriptor]
                            |
            +---------------+---------------+
            |                               |
            v                               v
[Annotation Target]               [Target Snapshot]
          |
          +--在当前 Data 上重新定位--> [Target Resolution]

[Human] --写入--> [Annotation] --附着于--> [Annotation Target]

[Annotation] + [Target Snapshot] --> [Annotation Store]

[External Agent] <--读取 / 回复--> [Annotation API] --> [Annotation Store]

[Annotation] != [Artifact Tool Call]
```

**Selection**：
人在 Artifact UI 中当前所指范围的短生命周期抽象规则；它可以表示源码或文本范围、媒体时间范围、
数据引用、DOM 元素或坐标区域，而不绑定具体输入设备。
_避免使用_：UI 高亮、DOM Range、Annotation Target、已保存选择

**Annotation Target**：
Annotation 所指 Artifact UI 局部内容的可解析描述，可以使用 Package 提供的身份，也可以使用文本、
DOM、媒体或坐标选择器。
_避免使用_：DOM 节点、Selection、原始 CSS Selector

**Target Descriptor**：
Package 或 DOM Inspector 根据 Selection 生成的目标描述，包含身份、位置、来源、有限结构化证据和附件引用。
_避免使用_：Public State、任意数据转储、原始 DOM 树

**Target Snapshot**：
创建 Annotation 时冻结保存的 Target Descriptor；即使 Instance Data 变化或 Target 无法重新定位，它仍作为
当时上下文的证据。
_避免使用_：当前 Artifact UI、实时 Instance Data、单独一张截图

**Target Resolution**：
在当前 Instance Data 上重新解析 Annotation Target 得到的定位结果。只有唯一的 `resolved` 结果可以继续
执行相关 Tool；`ambiguous`、`orphaned` 或 `unsupported` 都必须要求 Human 重新选择。Target Snapshot
只保留历史证据，不替代当前定位。
_避免使用_：Target Snapshot、模糊匹配成功、静默回退

**Annotation**：
附着在 Annotation Target 上的持久消息，可以被讨论或解决，但不会自动请求或执行修改。
_避免使用_：Agent Task、Artifact Tool Call、命令、Artifact Input

**Annotation Status**：
Annotation 当前的协作状态。`open` 表示仍待讨论或处理；Tool 已成功提交并附带结果证据后进入
`applied`；结果经过 Agent 验证或 Human 验收后才进入 `resolved`。执行失败保持 `open`；
Human 拒绝 Agent 提案时进入 `rejected`，且不修改 Data。
_避免使用_：Tool 执行状态、Agent Task 状态、无证据的 resolved

**Human Decision**：
Human 对 Agent 提案的结构化判断，只包含 `approved`、`rejected` 与 `needs-revision`。
只有 `approved` 允许 Agent 继续执行；`rejected` 关闭提案且不执行；`needs-revision` 保持
Annotation 未解决，由 Agent 修改提案后再次请求确认。
_避免使用_：任意评论文本、Tool Call、自动授权

**Annotation Store**：
OA 为一个 Artifact Instance 持久保存 Annotations 与 Target Snapshots 的记录集合；它不拥有 Package
的业务数据。
_避免使用_：Instance Data、Agent Memory、Artifact 数据库

**Annotation API**：
OA 用于创建、读取、回复和解决 Annotation 的界面；Package 可以通过它补充精确 Target，外部 Agent
可以通过它获取人的上下文。
_避免使用_：Tool API、Agent 执行 API、Data API

**DOM Inspector**：
Workbench 提供的默认 Selection 解释器，把 DOM 元素或文本范围转为 Target Descriptor，使未集成
Package 专用标注能力的 Artifact UI 仍可被标注。
_避免使用_：浏览器自动化、源码编辑器、Agent 执行器

## Tool 语言

```text
[Artifact Package] --声明--> [Artifact Tool]
                                  |
                           绑定到具体 Instance
                                  |
                                  v
[External Agent] --发现 / 调用--> [Tool API] --> [Artifact Tool Call]
                                                    |
                                                    v
                                              [Instance Data]

[Annotation] --可以为调用提供上下文--> [Artifact Tool Call]
[Annotation] != [Artifact Tool Call]
```

**Artifact Tool**：
由 Artifact Package 声明、针对一个具体 Artifact Instance 调用的具名领域操作；输入、结果与业务含义
属于 Package。
_避免使用_：OA 命令、DOM 自动化、Annotation、通用 Agent Tool

**Tool API**：
OA 为外部 Agent 提供的 Artifact Tool 发现与调用界面；OA 把调用绑定到目标 Instance，但不定义
Tool 的业务含义。
_避免使用_：Annotation API、Package 业务 API、浏览器自动化

**Artifact Tool Call**：
Artifact Tool 针对一个 Artifact Instance 的单次调用；它可以读取或修改 Instance Data，并独立于
可能促成这次调用的 Annotation。
_避免使用_：Annotation、评论回复、Prompt、DOM 操作

## 源码所有权语言

```text
[Artifact Package]
       |
       +--包含--> [Artifact Source]
                         |
                         +--复制并记录来源--> [Local Fork]

[Local Fork] != [Artifact Instance]
[Local Fork] --可发布为新的 Artifact Package--> [Package Binding]
```

**Local Fork**：
带有上游来源记录、可独立维护的 Artifact Source 副本；它表示源码所有权，不是 Artifact Instance
的复制品，也不限定为 Git 托管平台上的 fork。
_避免使用_：GitHub Fork、复制 Instance、导出 Artifact UI
