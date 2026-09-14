---
title: "Agent Harness：会话管理（二）：持久化与恢复"
createdAt: 2026-09-14 01:59
updatedAt: 2026-09-14 01:59
tags:
  - Agent开发
  - 后端
---

## 前言

上一篇讲了为什么不同项目、不同任务之间需要进行会话隔离。这一篇继续解决另一个问题：Agent 被关闭或意外中断以后，如何恢复之前的工作？

很多介绍会把这件事讲成“保存聊天记录，再把聊天记录读回来”。但 Agent 不只是聊天工具。它会读取和修改文件、执行命令、运行测试，甚至启动进程。因此，会话恢复至少要区分三件事：

- Agent 过去记录了什么；
- 下一次调用模型时，需要把哪些内容发给模型；
- 文件、Git、进程等外部环境现在是什么状态。

这三件事不能混为一谈。下面从一个具体场景开始。

## 1. 一个具体场景

假设你在 `/project_A` 中使用 Agent：

你：帮我检查 login.py 为什么登录失败。

Agent：我先读取 login.py。
Agent：这里可能有一个判断问题……
Agent：我再检查 auth.py
...

工作到一半，你按下 Ctrl+C，Agent 进程结束。

程序都已经退出了，内存也已经释放。为什么第二天执行 resume，昨天的对话还能重新显示出来？

原因其实很简单：这些内容在昨天运行的时候，就已经被不断写到了磁盘。

例如用户发了一条消息，程序保存一条记录；模型产生回复，再保存一条记录；调用工具、工具返回结果，也继续保存。

所以程序退出以后，虽然内存中的 Session 消失了，但磁盘中的 Session 记录还存在。

第二天执行 Resume，只不过是：

```text
找到这个 Session
    ↓
从磁盘读取它之前保存的记录
    ↓
重新恢复聊天界面
    ↓
恢复工作目录、执行状态等信息
    ↓
等待用户继续
```

这就是“会话持久化”和“会话恢复”最基本的意义：持久化负责把内存中的重要状态保存下来；恢复负责在程序重新启动以后把这些状态读回来。

考虑一种更麻烦的情况：你按下 Ctrl+C 时，Agent 正准备执行一次写文件操作。恢复会话以后，程序发现这次 ToolCall 有记录，却没有对应的 ToolResult。那么它怎么判断这次写入到底有没有成功？又应该如何安全地继续？

## 2. 先分清会话、执行轮次、事件和上下文

为了避免后面混乱，先区分四个概念：

### 2.1 Session：一项长期任务的容器

Session 表示一段可以多次继续的任务或对话。例如，“修复 project_A 的登录问题”可以对应一个 Session。它通常保存：

- session_id：会话编号
- user_id：会话属于谁
- workspace：会话绑定的项目目录
- status：会话是否仍在使用
- created_at、updated_at：创建和更新时间

会话的完整生命周期可以包含创建、运行、等待、完成、失败、取消和归档等状态。不过本地 Agent 的初版不必设计得过于复杂，通常只需要 active、completed、archived，再记录最近一次 Run 是执行中、成功、失败还是中断，我认为足够了。

### 2.2 Run：Session 中的一次执行

同一个 Session 可以包含多次用户触发的执行：

```text
Session S1：修复登录问题
├── Run R1：先检查代码
├── Run R2：继续修改
└── Run R3：运行测试
```

用户每发送一次新要求，Agent 从接收要求到给出本轮结果，可以视为一次 Run。

Run 通常记录 run_id、session_id、开始时间、结束时间、执行状态和错误信息。

### 2.3 Event：Run 中实际发生的一件事

一次 Run 内部会发生很多事件，例如：

- 收到用户消息
- 模型产生回复
- 模型请求使用工具
- 工具返回执行结果
- 本轮执行结束

这些按时间排列的记录就是事件流水。

### 2.4 Context：本次真正发给模型的内容

Event 保存的是完整历史，Context 则是某一次调用模型前，从历史中挑选、整理出来的内容。

例如，一个会话已经产生十万字的事件记录，但本次可能只发送：

- 较早历史的摘要
- 最近几轮消息
- 当前任务进度
- 本次确实需要的工具结果

因此 Event Log 不等于模型上下文。读取历史是本地读文件，只有把选出的 Context 发给模型时才会消耗输入 Token。

## 3. 为什么 Session 必须保存 workspace

workspace 不是提醒模型“你在哪个项目”，而是让 Agent 的运行框架把工具绑定到正确目录。如果恢复时直接使用当前终端目录：`workspace = os.getcwd()`，那么你在 project_B 中恢复 project_A 的会话后，模型发出：`read_file("login.py")`，工具可能实际读取 `~/projects/project_B/login.py`，这就导致串线了。

Resume 时程序需要知道这个 Session 上一次在哪里工作，并据此决定本次应该继续在哪个目录工作。大致思路：

```JSON
{
    "session_id": "xyz123",
    "cwd": "/home/user/projects/project_A"
}
```

Resume:

```python
session = load("xyz123")

print(session.cwd)
# /home/user/projects/project_A
```

程序于是知道：这个 Session 上次是在 `/project_A`。如果当前也在，那就直接继续。如果不在，就根据配置选择或者询问用户。

随后，ReadFile、WriteFile、Bash 等工具都通过这个 tool_context 解析路径。

也就是说，工具可以全局注册，但工具实际能访问哪个目录，应由当前 Session 的运行环境决定，不应该在全局工具注册表中永久写死 /project_A。

你可能会问，这不是很奇怪吗？为什么在 `/project_A` 下的会话，可以在 `/project_B` 中恢复？

实际上这么做更好。因为用户完全有可能将 `/project_A` 移动到其它目录下，如果仅仅因为 cwd 不同就拒绝 resume，那这个移动的 Session 就彻底废了。

## 4. Session、Run、Event 是否必须分成三个文件

不必须。Session、Run、Event 描述的是三种逻辑关系，不代表磁盘上必须存在 session.json、runs.jsonl、events.jsonl 三个文件。对于一个本地 Coding Agent，最简单的目录可以只有：

```text
~/.agent/sessions/
└── s_001/
    ├── session.json
    └── events.jsonl
```

session.json 保存少量、经常查询的会话信息：

```JSON
{
  "session_id": "s_001",
  "user_id": "u_001",
  "workspace": "/home/user/projects/project_A",
  "status": "active",
  "created_at": "...",
  "updated_at": "..."
}
```

events.jsonl 保存详细过程：

```JSON
{"type":"run_started","run_id":"r_001"}
{"type":"user_message","run_id":"r_001","content":"检查登录问题"}
{"type":"tool_call","run_id":"r_001","call_id":"c_001","tool":"read_file"}
{"type":"tool_result","run_id":"r_001","call_id":"c_001","status":"success"}
{"type":"run_finished","run_id":"r_001","status":"success"}
```

这里的 `run_started` 和 `run_finished` 已经标出了每个 Run 的边界，因此初版不需要单独建立 Run 文件。

只有当需要频繁查询“最近一百次 Run”“所有失败的 Run”“平均运行时间”时，才值得在 SQLite 中单独建立 runs 表。此时 Run 表保存的是开始时间、结束时间、状态等索引信息，详细过程仍然由 Event 保存，两者并不冲突。

## 5. 为什么不把所有内容都放进 session.json

可以放，但运行时间越长，代价越明显。

假设一个会话产生了数百条消息、几百次工具调用，以及大量日志和测试输出。如果全部放入一个大 JSON，每新增一条记录，都可能需要：

- 读取整个文件
- 解析整个 JSON
- 添加一条记录
- 重新写回整个文件

因此更合理的做法是：

- session.json 保存体积小、需要快速读取的会话信息；
- events.jsonl 保存不断追加的详细历史。

这样拆分并不会减少总数据量。Event 文件仍然可能很大。拆分的真正目的，是让“会话列表等高频信息”和“庞大的历史流水”分开读取。

Event 文件变大以后，可以按需读取、分页、压缩、归档，也可以定期生成摘要。日常展示会话列表时，没有必要扫描几百 MB 的历史记录。

## 6. 为什么事件流水适合 Agent

普通聊天通常只有用户消息和助手消息，而 Agent 的真实过程还包括工具调用、工具结果、状态变化和错误。例如：

```JSON
{
  "type": "tool_call",
  "call_id": "call_123",
  "tool": "bash",
  "args": {"command": "pytest"}
}
```

下一条事件可能是：

```JSON
{
  "type": "tool_result",
  "call_id": "call_123",
  "status": "failed",
  "exit_code": 1
}
```

程序崩溃以后，运行框架可以根据事件流水判断：上一轮从哪里开始、执行过哪些工具、最后一项操作是否收到了结果。这里不需要模型猜测。事件由 Agent 运行框架在执行过程中记录。

## 7. 持久化时机：不需要写很多 if/else

不是让模型判断哪个事件关键，而是只要运行框架产生了需要记录的 Event，就通过统一入口立即追加到存储中。

例如：

```python
def emit(event):
    event_store.append(event)
    event_bus.publish(event)
```

这里 `event_bus` 解决的是：一个 Event 刚发生，现在程序内部有哪些模块需要马上知道？例如：

```text
Agent Runtime
    ↓
产生 ToolCall
    ↓
EventBus
    ├── UI：显示“正在读取文件”
    ├── Logger：打印日志
    ├── Telemetry：统计工具调用次数
    └── SSE：推送给前端
```

收到用户消息时：

```python
emit(UserMessageReceived(...))
```

工具开始和结束时：

```python
emit(ToolCallCreated(...))
result = tool.execute(...)
emit(ToolResultReceived(...))
```

本轮完成时：

```python
emit(RunCompleted(...))
```

所以，不是模型知道“现在发生了关键事件”，也不是在一个保存函数里堆许多 if/else。而是程序中所有标准事件都走同一个 emit → append 通道。

如果等整个 Run 结束后才统一保存，那么运行十分钟后在第九分钟崩溃，前面的记录可能全部丢失。逐条追加可以把损失缩小到最后一个尚未成功写入的事件。

## 8. 为什么使用 JSONL 或 SQLite

JSONL 每行是一条独立 JSON，适合追加写：

```JSONL
{"type":"user_message", ...}
{"type":"tool_call", ...}
{"type":"tool_result", ...}
```

新增事件时只需在文件末尾增加一行，不必重写整个历史文件，也方便开发者直接查看和调试。

SQLite 则适合需要事务和查询的本地 Agent。可以建立 sessions、runs、events 等表，同时仍然只产生一个数据库文件。

两者没有绝对高下：

- 初版、重视简单和可读性：session.json + events.jsonl；

- 需要条件查询、事务和统计：SQLite。

当前 Codex CLI 会把 Session 的详细执行记录保存到：

```text
~/.codex/sessions/
    YYYY/
        MM/
            DD/
                rollout-时间戳-SessionID.jsonl
```

我以我本地的 `.jsonl` 文件为例，挑一个较短的 JSON 字符串：

```JSON
{
        "timestamp":"2026-09-10T03:07:49.485Z",
        "ordinal":326,
        "type":"response_item",
        "payload":{
                "type":"custom_tool_call",
                "id":"ctc_07319f63bba190c1016aa21f02720887d0a0c4edf1df53cf75",
                "status":"completed",
                "call_id":"call_JpARZq1RTScKdLZhRHt742Sz",
                "name":"exec",
                "input":"const r = await tools.exec_command({\n  cmd: \"sed -n '316,352p' PRODUCT_SPEC.md\",\n  workdir: \"/home/kevinbarrus/projects/coverbot\",\n  yield_time_ms: 10000,\n  max_output_tokens: 8000\n});\ntext(r.output);\n","internal_chat_message_metadata_passthrough":{
                        "turn_id":"01a08943-8768-7dc1-a0ce-ec38f0734c3a",
                        "create_time":1789009663.883205
                }
        }
}
```

是的，这就是我本人真实电脑中的 JSONL 文件， `rollout-xxx.jsonl` 文件保存详细 Session 流水。

你也可以去看看你的 codex 对话记录，看看有哪些字段，讲再多都不如自己去看一下 Codex 究竟具体是怎么存的。也可以看一下 `state_5.sqlite` 、`session_index.jsonl` 和 `history.jsonl`，其中 history 存了所有你在 Codex 中发送的消息，有一种看小时候照片的回忆感。

我还是以我真实的 `history.jsonl` 文件内容作为例子，当时我尝试使用本地模型进行文章的批量翻译，但是效果不好，于是委托 gpt 进行翻译：

```JSONL
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788442336,"text":"开始进行英文文章批量翻译。进行1：1翻译，翻译完之后你逐个进行检查"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788443559,"text":"那就你来执行吧。几篇几篇地翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788444096,"text":"继续翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788444391,"text":"继续翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788444579,"text":"继续翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788444983,"text":"继续翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788445742,"text":"继续翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788445902,"text":"继续翻译"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788446062,"text":"继续"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788446202,"text":"继续"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788446362,"text":"继续"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788446547,"text":"继续"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788446645,"text":"继续被中断的任务"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788446667,"text":"继续被中断的任务"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788449845,"text":"继续被中断的任务"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788449968,"text":"继续"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788450492,"text":"继续"}
{"session_id":"01a0481a-c49d-72d3-b3a6-36c9fb4dcd8f","ts":1788450595,"text":"继续"}
```

看吧，多么朴实无华的对话内容哈哈哈。

这和我们说的 session metadata + event log 非常接近。

也可以去看看 pi 的存储，内容在：

```text
~/.pi/agent/sessions/
    --home-user-project_A--/
        timestamp_uuid.jsonl
```

## 9. 恢复 Session

恢复流程的主体是 Agent Harness，也就是我们编写的普通程序，而不是大语言模型。

一个最小流程可以写成：

```python
def resume_session(session_id):
    session = session_store.load(session_id)

    workspace = Path(session.workspace)
    if not workspace.exists():
        raise WorkspaceNotFound()

    events = event_store.load(session_id)
    recover_interrupted_run(events)

    context = context_builder.build(events)

    return AgentRuntime(
        session=session,
        workspace=workspace,
        events=events,
        context=context,
    )
```

“读取历史”和“把历史全部发送给模型”是两件不同的事。前者只是本地读文件，不消耗模型 Token；后者才会产生模型输入费用。

## 10. 当前目标和任务进度从哪里来

不是每个 Agent 都必须单独维护一份任务状态。对于简单任务，事件历史中已经记录了用户要求、工具调用和模型回复。恢复时选择必要历史作为 Context，通常就足够了。至于怎么选择，我们放在下一篇上下文管理当中再讲。

对于步骤较多的任务，可以额外保存结构化任务状态：

```JSON
{
  "goal": "修复登录问题",
  "status": "in_progress",
  "completed_steps": ["检查 login.py"],
  "pending_steps": ["修改代码", "运行测试"]
}
```

它可能来自模型生成的计划，但生成后应由运行框架解析并保存。每完成一步，由任务管理代码更新对应步骤，不需要每轮都让模型重新总结全部历史。

当历史过长时，也可以偶尔让模型生成一份阶段摘要或检查点，保存当前目标、重要发现、已完成工作和待办事项。下次恢复时直接加载这份摘要，而不是重新把完整历史交给模型压缩。

所以，任务状态和摘要是长任务的优化手段，不是所有 Session 天然具备的内容。

说到长任务，自然想到 Codex 的 `/goal`，我们同样在 `~/.codex` 下看到关于 goal 的 sqlite 文件，我依然以我本地的真实文件的部分内容为例：

```SQL
CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'active',
        'paused',
        'blocked',
        'usage_limited',
        'budget_limited',
        'complete'
    )),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
)
```

## 11. 如何判断上一 Run 被异常中断

假设事件流水最后只有：

```JSON
{"type":"run_started","run_id":"r_015"}
```

却没有对应的：

```JSON
{"type":"run_finished","run_id":"r_015"}
```

当前程序又已经重新启动。在“同一 Session 同时只允许一个主要 Run”的本地设计中，新的运行框架可以直接判断：r_015 没有正常收尾，应标记为 interrupted。

这仍然由普通程序完成：

```python
if last_run.status == "running":
    last_run.status = "interrupted"
```

在线系统中可能有多个工作进程，不能仅凭重新启动判断。此时可以为 Run 保存 worker_id、心跳或租约到期时间。超过期限仍未续约，才判断对应工作进程已经失联。

无论哪种方式，都不需要模型检查操作系统进程，更不需要模型下令修改 Run 状态。

## 12. 恢复内部记录，不等于扫描整个外部世界

文件内容、Git 分支、后台进程、端口、部署状态都可能在 Agent 退出后发生变化。但这不意味着每次恢复会话，都要立刻扫描所有文件、进程、端口和外部服务。

更合理的原则是，只在以下三种情况下查询当前状态：


- 接下来要依赖它
- 接下来要修改它
- 上一次操作是否成功无法确定

例如，Agent 接下来准备修改 `login.py`，就在修改前重新读取或校验该文件。准备继续使用某个后台服务时，再检查服务是否仍然可用。

Session 恢复负责加载 Agent 的内部记录，工具负责在真正需要时观察外部世界。

## 13. ToolCall 有记录、ToolResult 没记录时怎么办

假设崩溃前的 Event Log：

```JSON
{
        "type":"tool_call",
        "call_id":"c123",
        "tool":"write_file",
        "path":"main.py"
}
```

然后你按下了 Ctrl+C，没有得到：

```JSON
{
        "type":"tool_result",
        "call_id":"c123"
}
```

存在两种可能：

- 文件已经写成功，只是结果还没来得及持久化
- 工具还没执行，程序就崩溃了

那么恢复的时候可以做：

```python
calls = find_tool_calls(events)
results = find_tool_results(events)

for call in calls:
    if call.id not in results:
        unresolved.append(call)
```

此时不能直接重试，因为写文件、部署、创建 Issue 等操作都可能产生重复副作用。运行框架可以先把它记录为“结果不确定的操作”，等真正要处理它时，交给对应工具核对：

```text
SessionManager
    → 发现 c123 没有结果
    → 标记为 uncertain

WriteFileTool
    → 根据目标内容或文件版本检查是否已写入
```

这里标记为 uncertain，是追加一条恢复事件：

```JSON
{
  "type": "tool_recovery",
  "call_id": "c123",
  "status": "uncertain"
}
```

SessionManager 怎么知道 c123 没有结果？

这里隐含的第一步是：

```python
events = load_events(session_id)
```

例如：

```python
with open("events.jsonl") as f:
    for line in f:
        event = json.loads(line)
```

但实际上没必要每次 Resume 都扫描几十万行。只需要找到最后一个 `run_started`，然后只分析它后面的 Event（当然如果只有一个 run 那实际上也还是要全部都扫描的）。或者你也可以维护一张运行状态表 runs 以及工具调用记录表 tool_calls，只需执行：

```SQL
SELECT *
FROM tool_calls
WHERE run_id = 'R105'
AND status = 'pending';
```

避免重新扫描历史。

那么 LLM 怎么知道有工具没有得到执行结果？

这才是关键，你辛辛苦苦给领导的花浇了水，结果领导没看见，一切都无济于事。

Harness 必须在构建下一次 Context 的时候告诉 LLM。大体流程是这样：

```text
SessionManager
发现 c123 没结果
        ↓
生成结构化 RecoveryState
        ↓
Context Builder
把结构化状态转换成模型消息
        ↓
加入下一次 Context
        ↓
LLM 看见
```

例如 Harness 得到：

```python
recovery_state = {
    "interrupted_run": "R105",
    "uncertain_calls": [
        {
            "call_id": "c123",
            "tool": "write_file",
            "path": "main.py"
        }
    ]
}
```

Context Builder 可以把它格式化为：

```text
<recovery>
上一轮执行被意外中断。

以下工具调用没有得到明确执行结果：

- call_id: c123
- tool: write_file
- target: main.py

不能确定该写入是否已经完成。
在继续依赖 main.py 之前，请先确认文件当前状态。
</recovery>
```

然后放进下一次模型输入。所以类似于：

```python
template = """
上一轮执行被意外中断。

以下操作结果未知：
{uncertain_operations}

在继续依赖这些操作之前，请先确认当前真实状态。
"""
```

然后：

```python
recovery_prompt = template.format(
    uncertain_operations=format_ops(ops)
)
```

## 14. 为什么 ToolCall 需要唯一编号

每次工具调用都应有唯一的 call_id：

```text
ToolCall  call_123
    ↓
ToolResult call_123
```

恢复时，程序可以据此判断每个 ToolCall 是否找到了对应结果。

对于会产生外部副作用的操作，还可以增加 operation_id。如果外部服务支持幂等请求，多次提交同一个 operation_id 只产生一次结果，可以进一步降低重复执行的风险。

但 call_id 和 operation_id 作用不同：

- call_id 用来关联 Agent 内部的调用和结果
- operation_id 用来避免外部操作被重复执行

## 15. Agent 如何发现文件被手动修改

一个具体情景：

10:00
read main.py

10:05
用户手动修改 main.py

10:10
Agent 想修改 main.py

Agent 并不知道 10:05 发生了什么。

常见做法有以下几种。

### 15.1 再次读取

我们做一个约束：每次对文件执行写操作前，都必须要先读文件。

这么一来，就不是“因为知道变了，所以重新读”，而是“因为我重新读了，所以我知道变了”。

### 15.2 版本校验

读取文件时，工具同时返回内容哈希：

```JSON
{
  "content": "...",
  "version": "abc123"
}
```

写入时带上这个版本：

```python
write_file(path="main.py", expected_version="abc123", ...)
```

工具执行时：

```python
actual_hash = hash(file)

if actual_hash != expected_hash:
    return FILE_CHANGED
```

因此完全不需要 LLM 主动想到“我要重新读”，而是工具直接防止覆盖旧版本。

### 15.3 补丁无法匹配

补丁，顾名思义，找到一段旧内容，然后替换成新内容。

假设原文件有这么一段内容：

```python
def add(a, b):
    return a - b
```

Agent 不重新覆盖整个文件，而是使用 `apply_patch` 工具修改文件：

```diff
-    return a - b
+    return a + b
```

但如果用户已经手动改成：

```python
def add(a, b):
    return sum([a, b])
```

原来的 `return a - b` 已经不存在了。那补丁工具就会：

```text
Patch failed:
old context not found
```

于是 Agent 才知道：我之前看到的文件已经不是现在这个样子了，然后重新读取。

问题来了，补丁工具是怎么知道 Patch failed 的呢？实际上就是 `apply_patch` 读取磁盘里的文件，尝试找到 `return a - b`，但是此时用户已经修改了，所以它肯定找不到，无法确认这个 Patch 应该应用在哪里。流程为：

```text
Patch 中带了一小段“我认为文件现在长这样”的旧内容
        ↓
apply_patch 读取真实文件
        ↓
查找旧内容
        ↓
找到
→ 应用修改

没找到
→ 拒绝修改
```

关于 `apply_patch`，后面再简单写一篇文章讲一讲，这里不展开。

整个流程为：

```text
模型之前读取 main.py
        ↓
基于当时内容生成 Patch

-old code
+new code
        ↓
调用 apply_patch
        ↓
apply_patch 重新读取当前 main.py
        ↓
寻找 Patch 中描述的旧代码和上下文
        ↓
┌───────────────┬────────────────┐
│ 找得到        │ 找不到          │
│               │                 │
│ 应用 Patch    │ Patch failed    │
└───────────────┴────────────────┘
                        ↓
                  告诉 LLM
                        ↓
                  重新读取文件
```

所以补丁不是提前发现修改，而是修改时发现“我准备修改的旧内容已经不存在了”。

因此，Agent 在没有恢复会话的情况下也能发现脏文件，是因为它在正常运行时重新读取或校验了文件，而不是因为 Session 恢复机制检查了整个项目。


## 16. Git、进程和端口也按需检查

事件历史只能说明 Agent 过去观察到了什么。例如：

10:30：Git 分支是 main
10:35：进程 1234 正在运行

它不能证明这些状态现在仍然成立。

当真正需要 Git 状态时，再执行：

```bash
git status --porcelain
git branch --show-current
git rev-parse HEAD
```

只有当某个 Git 操作确实依赖某个前置状态时，才由该 Git 工具在执行前做必要检查。不是 Resume 时全量检查，也不是每轮强迫 LLM 执行一套 Git 命令，那是完全没必要的，浪费 token。

当 Agent 真正需要某个进程时，由进程工具根据它保存的进程信息检查，而不是由 SessionManager 理解所有命令、目录和端口。

也就是说，谁创建和管理某种外部资源，谁负责提供相应的检查逻辑。会话管理模块只负责保存引用和不确定状态，不需要变成一个认识所有外部系统的巨大判断器。

## 17. 并发控制

假设同一个 Session 中：

- Run A 正在修改 main.py
- Run B 同时开始运行测试

Run B 可能测到只修改了一半的代码，两个 Run 也可能同时修改同一个文件。因此，本地 Agent 最简单可靠的策略是：一个 Session 同一时间只执行一个主要 Run。新输入进入队列，等当前 Run 结束后再处理，不同 Session 可以并行运行。

这个约束也使中断判断更简单：新 Runtime 恢复会话时，如果发现上一个 Run 仍标记为 running，就能将其视为未正常结束。

## 18. 本地 Agent 与在线服务的区别

本地 Agent 通常只有一个程序实例，session.json + events.jsonl 或 SQLite 已经足够。

在线服务可能同时有多台服务器。用户第一次请求落在服务器 A，下一次请求可能落在服务器 B。因此 Session 不能只保存在某台服务器的本地磁盘中，而要放在各实例都能访问的持久化存储里。这就是经典的那一套后端工程了。常见分工是：

- 数据库保存不能丢的 Session、Run 和 Event
- Redis 保存锁、短期缓存、正在运行的标记和在线状态等临时数据

Redis 的重点是快速访问和多实例协调，数据库的重点是持久、可靠和可查询。不能把唯一一份完整会话只放在可能被淘汰的临时缓存中。

## 19. 一套清晰的恢复流程

恢复会话时，可以采用下面的最小流程：

```text
用户执行：codex resume xyz123
        ↓
程序根据 xyz123 找到对应 Session
        ↓
读取 Session 信息：ID、原工作目录等
        ↓
如果当前目录与原目录不同决定本次使用哪个目录
        ↓
设置 Runtime 的 cwd
以后 read_file("a.py")、bash("pytest")
都以这个目录为默认工作目录
        ↓
读取 Session 历史文件
        ↓
把历史恢复到聊天界面
        ↓
读取最后一个 Run
        ↓
如果它没有正常结束
标记为 interrupted
        ↓
检查这个 Run 中
是否存在有 ToolCall、无 ToolResult
        ↓
如果存在
记录为“结果未知”
        ↓
加载 Goal、摘要等额外状态
        ↓
Context Builder 准备：
系统提示词
+ 项目说明
+ Skill
+ Goal
+ 历史摘要
+ 最近消息
+ 中断恢复信息
        ↓
Resume 完成
        ↓
等待用户下一条消息
```

放在整个 run 过程中，大概就是：

```text
磁盘中的 Session/Event
        ↓
Harness 恢复
        ↓
内部 Session State
        ↓
Context Builder
        ↓
LLM
        ↓
ToolCall
        ↓
Tool 查询真实世界
        ↓
ToolResult
        ↓
Event Store
        ↓
再进入下一次 Context
```
