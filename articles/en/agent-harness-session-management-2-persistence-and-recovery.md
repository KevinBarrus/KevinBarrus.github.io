---
title: "Agent Harness Session Management (Part 2): Persistence and Recovery"
createdAt: 2026-09-14 01:59
updatedAt: 2026-09-14 01:59
tags:
  - Agent开发
  - 后端
---

## Preface

The previous article explained why sessions must be isolated across different projects and tasks. This article addresses the next problem: how can an Agent resume its previous work after it has been shut down or interrupted unexpectedly?

Many explanations reduce this to “save the chat history, then read it back.” But an Agent is more than a chat tool. It reads and modifies files, executes commands, runs tests, and may even start processes. Session recovery must therefore distinguish at least three things:

- what the Agent recorded in the past;
- what must be sent to the model on the next model call;
- the current state of external environments such as files, Git, and processes.

These three things must not be conflated. Let us begin with a concrete scenario.

## 1. A Concrete Scenario

Suppose you are using an Agent in `/project_A`:

You: Check why login fails in login.py.

Agent: I’ll read login.py first.
Agent: There may be a problem with this condition...
Agent: I’ll also inspect auth.py.
...

Halfway through the task, you press Ctrl+C and terminate the Agent process.

The program has exited and its memory has been released. Why can yesterday’s conversation still appear when you run `resume` the next day?

The reason is simple: while the Agent was running yesterday, it was continuously writing these records to disk.

When the user sends a message, the program saves a record. When the model replies, it saves another. Tool calls and tool results are saved as well.

After the program exits, the in-memory Session is gone, but the Session records on disk remain.

Running Resume the next day simply means:

```text
Find the Session
    ↓
Read its previously saved records from disk
    ↓
Restore the chat interface
    ↓
Restore information such as the workspace and execution state
    ↓
Wait for the user to continue
```

This is the most basic meaning of “session persistence” and “session recovery”: persistence saves important in-memory state, while recovery reads that state after the program starts again.

Now consider a more troublesome case. When you pressed Ctrl+C, the Agent was about to perform a file write. After recovery, the program finds a ToolCall record but no matching ToolResult. How can it determine whether the write succeeded, and how should it continue safely?

## 2. Distinguishing Sessions, Runs, Events, and Context

To avoid confusion later, let us first distinguish four concepts.

### 2.1 Session: The Container for a Long-Running Task

A Session represents a task or conversation that can be continued multiple times. For example, “fix the login problem in project_A” can correspond to one Session. It commonly stores:

- `session_id`: the session identifier;
- `user_id`: the user who owns the session;
- `workspace`: the project directory bound to the session;
- `status`: whether the session is still in use;
- `created_at` and `updated_at`: creation and update timestamps.

A complete session lifecycle may include states such as created, running, waiting, completed, failed, cancelled, and archived. The first version of a local Agent does not need that much complexity. In my view, `active`, `completed`, and `archived` are enough, provided that the most recent Run also records whether it is running, succeeded, failed, or was interrupted.

### 2.2 Run: One Execution Within a Session

The same Session may contain several user-triggered executions:

```text
Session S1: Fix the login problem
├── Run R1: Inspect the code
├── Run R2: Continue modifying it
└── Run R3: Run the tests
```

Each time the user sends a new request, the work from receiving that request through producing the result for that turn can be treated as one Run.

A Run commonly records `run_id`, `session_id`, its start and end times, execution status, and error information.

### 2.3 Event: Something That Actually Happened During a Run

Many events occur within a Run, for example:

- a user message is received;
- the model produces a response;
- the model requests a tool call;
- the tool returns a result;
- the current Run finishes.

These chronologically ordered records form the event stream.

### 2.4 Context: What Is Actually Sent to the Model This Time

Events preserve the complete history. Context is the content selected and organized from that history before a particular model call.

For example, a session may have accumulated one hundred thousand Chinese characters of event records, while the current call sends only:

- a summary of earlier history;
- the most recent turns;
- the current task progress;
- the tool results actually needed for this call.

The Event Log is therefore not the same thing as model context. Reading history means reading a local file. Input tokens are consumed only when the selected Context is sent to the model.

## 3. Why a Session Must Store Its Workspace

The workspace is not merely a reminder telling the model “which project you are in.” It allows the Agent framework to bind tools to the correct directory. If recovery simply uses the current terminal directory—`workspace = os.getcwd()`—then restoring a project_A session from project_B could cause a model call such as `read_file("login.py")` to read `~/projects/project_B/login.py`. The session has crossed into the wrong project.

On Resume, the program must know where this Session previously worked and decide which directory to use now. The stored data might look like this:

```json
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

The program now knows that this Session previously ran in `/project_A`. If the current directory matches, it can continue directly. Otherwise, it can choose according to configuration or ask the user.

Tools such as ReadFile, WriteFile, and Bash then resolve paths through this `tool_context`.

In other words, tools may be registered globally, but the directory a tool can actually access should be determined by the current Session’s runtime environment. `/project_A` should not be permanently hard-coded into a global tool registry.

You may wonder why a session created under `/project_A` can be resumed from `/project_B` at all.

Allowing this is actually better. The user may have moved `/project_A` elsewhere. If a different `cwd` were enough to reject Resume, the moved Session would become unusable.

## 4. Must Session, Run, and Event Be Stored in Three Separate Files?

No. Session, Run, and Event describe three logical relationships; they do not require three physical files named `session.json`, `runs.jsonl`, and `events.jsonl`. A local Coding Agent can start with a directory this simple:

```text
~/.agent/sessions/
└── s_001/
    ├── session.json
    └── events.jsonl
```

`session.json` stores a small amount of frequently queried session metadata:

```json
{
  "session_id": "s_001",
  "user_id": "u_001",
  "workspace": "/home/user/projects/project_A",
  "status": "active",
  "created_at": "...",
  "updated_at": "..."
}
```

`events.jsonl` stores the detailed execution history:

```jsonl
{"type":"run_started","run_id":"r_001"}
{"type":"user_message","run_id":"r_001","content":"Inspect the login problem"}
{"type":"tool_call","run_id":"r_001","call_id":"c_001","tool":"read_file"}
{"type":"tool_result","run_id":"r_001","call_id":"c_001","status":"success"}
{"type":"run_finished","run_id":"r_001","status":"success"}
```

Here, `run_started` and `run_finished` already mark the boundaries of each Run, so the first version does not need a separate Run file.

A separate `runs` table in SQLite becomes worthwhile only when the system must frequently query things such as “the latest one hundred Runs,” “all failed Runs,” or “average runtime.” The Run table can then store indexed fields such as start time, end time, and status, while the detailed process remains in Events. These two representations do not conflict.

## 5. Why Not Put Everything in session.json?

You can, but the cost becomes increasingly obvious as the Agent runs longer.

Suppose a session accumulates hundreds of messages, hundreds of tool calls, and large amounts of logs and test output. If all of it lives in one large JSON document, adding each record may require the program to:

- read the entire file;
- parse the entire JSON document;
- append one record;
- rewrite the entire file.

A more reasonable division is:

- `session.json` stores small session metadata that must be read quickly;
- `events.jsonl` stores the detailed history that grows through appends.

This split does not reduce the total amount of data. The Event file can still grow very large. Its purpose is to separate frequently accessed information such as the session list from a massive historical stream.

Once the Event file becomes large, it can be read on demand, paginated, compressed, archived, or periodically summarized. Displaying the ordinary session list should not require scanning hundreds of megabytes of history.

## 6. Why an Event Stream Fits an Agent

An ordinary chat generally contains only user and assistant messages. An Agent’s real execution also includes tool calls, tool results, state changes, and errors. For example:

```json
{
  "type": "tool_call",
  "call_id": "call_123",
  "tool": "bash",
  "args": {"command": "pytest"}
}
```

The next event might be:

```json
{
  "type": "tool_result",
  "call_id": "call_123",
  "status": "failed",
  "exit_code": 1
}
```

After a crash, the runtime can use the event stream to determine where the previous Run began, which tools ran, and whether the final operation received a result. The model does not need to guess. The Agent runtime records these events as execution proceeds.

## 7. When to Persist: You Do Not Need a Pile of if/else Statements

The model does not decide which events are important. Whenever the runtime produces an Event that needs to be recorded, it immediately appends that Event through a single entry point.

For example:

```python
def emit(event):
    event_store.append(event)
    event_bus.publish(event)
```

The `event_bus` answers a different question: when an Event has just occurred, which modules inside the program need to know immediately? For example:

```text
Agent Runtime
    ↓
Produces a ToolCall
    ↓
EventBus
    ├── UI: display “Reading file”
    ├── Logger: print a log entry
    ├── Telemetry: count tool calls
    └── SSE: push the event to the frontend
```

When a user message arrives:

```python
emit(UserMessageReceived(...))
```

When a tool starts and finishes:

```python
emit(ToolCallCreated(...))
result = tool.execute(...)
emit(ToolResultReceived(...))
```

When the current Run finishes:

```python
emit(RunCompleted(...))
```

So the model does not somehow know that “a critical event has just occurred,” and the save function does not need a pile of `if/else` branches. Every standard event follows the same `emit → append` path.

If persistence waits until the entire Run finishes, a crash at minute nine of a ten-minute Run may lose all earlier records. Appending each event reduces the possible loss to the last event that had not yet been written successfully.

## 8. Why JSONL or SQLite?

In JSONL, every line is an independent JSON object, which makes the format suitable for appends:

```jsonl
{"type":"user_message", ...}
{"type":"tool_call", ...}
{"type":"tool_result", ...}
```

Adding an event only requires writing one line at the end of the file. The entire history does not need to be rewritten, and developers can inspect and debug the file directly.

SQLite is a better fit when a local Agent needs transactions and queries. It can contain tables such as `sessions`, `runs`, and `events` while still producing only one database file.

Neither is universally better:

- For a first version that prioritizes simplicity and readability: `session.json` + `events.jsonl`.
- For conditional queries, transactions, and statistics: SQLite.

Codex CLI currently stores detailed Session execution records under:

```text
~/.codex/sessions/
    YYYY/
        MM/
            DD/
                rollout-timestamp-SessionID.jsonl
```

Here is a relatively short JSON value taken from one of the `.jsonl` files on my own machine:

```json
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

Yes, this is a JSONL record from my actual computer. The `rollout-xxx.jsonl` files preserve detailed Session event streams.

You can inspect your own Codex conversation records to see which fields they contain. No amount of explanation is as direct as looking at how Codex actually stores them. You can also inspect `state_5.sqlite`, `session_index.jsonl`, and `history.jsonl`. The history file contains every message you have sent to Codex; reading it feels a little like looking at childhood photos.

Here is another example from my real `history.jsonl`. At the time, I tried using a local model to translate articles in batches. The result was not good, so I asked GPT to do it:

```jsonl
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

The messages say, in order, “start translating the English articles in batches,” “then you do it a few at a time,” followed by repeated requests to “continue translating,” “continue,” and “continue the interrupted task.” The records themselves remain unchanged because they are presented as actual stored data.

See? What a plain and unvarnished conversation, hahaha.

This is very close to the `session metadata + event log` structure discussed here.

You can also inspect pi’s storage, which is located at:

```text
~/.pi/agent/sessions/
    --home-user-project_A--/
        timestamp_uuid.jsonl
```

## 9. Recovering a Session

The main component responsible for recovery is the Agent Harness—the ordinary program we write—not the large language model.

A minimal flow might look like this:

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

“Reading history” and “sending the entire history to the model” are two different operations. The former only reads local files and consumes no model tokens; only the latter incurs model input cost.

## 10. Where Do the Current Goal and Task Progress Come From?

Not every Agent needs a separate task-state record. For simple tasks, the event history already contains the user’s request, tool calls, and model responses. Selecting the necessary history as Context during recovery is usually enough. We will discuss how to select it in the next article on context management.

For tasks with many steps, the Agent can persist additional structured task state:

```json
{
  "goal": "Fix the login problem",
  "status": "in_progress",
  "completed_steps": ["Inspect login.py"],
  "pending_steps": ["Modify the code", "Run the tests"]
}
```

This state may originate from a plan generated by the model, but once generated, it should be parsed and stored by the runtime. As each step finishes, task-management code updates the corresponding record. The model does not need to summarize the entire history again on every turn.

When the history becomes too long, the model can occasionally generate a phase summary or checkpoint that records the current goal, important findings, completed work, and pending tasks. The next recovery can load this summary directly instead of sending the complete history back to the model for compression.

Task state and summaries are therefore optimizations for long-running tasks, not properties that every Session naturally possesses.

Speaking of long-running tasks naturally brings Codex `/goal` to mind. Under `~/.codex`, we can likewise find a SQLite file related to goals. Here is part of the schema from my local machine:

```sql
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

## 11. Determining Whether the Previous Run Was Interrupted

Suppose the event stream ends with only:

```json
{"type":"run_started","run_id":"r_015"}
```

and has no matching:

```json
{"type":"run_finished","run_id":"r_015"}
```

The program has since restarted. In a local design that permits only one primary Run at a time in the same Session, the new runtime can directly conclude that `r_015` did not finish normally and should be marked `interrupted`.

An ordinary program still performs this operation:

```python
if last_run.status == "running":
    last_run.status = "interrupted"
```

An online system may have several worker processes, so a restart alone is not enough to reach that conclusion. The system can instead store a `worker_id`, heartbeat, or lease expiration time for each Run. Only when the lease expires without renewal does it conclude that the corresponding worker has been lost.

Neither design requires the model to inspect operating-system processes or instruct the system to change the Run status.

## 12. Recovering Internal Records Does Not Mean Scanning the Entire External World

File contents, Git branches, background processes, ports, and deployment state may all change after the Agent exits. That does not mean every resumed session must immediately scan every file, process, port, and external service.

A more reasonable principle is to query current state only when one of these conditions holds:

- the next operation depends on it;
- the next operation will modify it;
- whether the previous operation succeeded is uncertain.

For example, if the Agent is about to modify `login.py`, it should reread or validate the file immediately before the modification. If it needs to continue using a background service, it should check whether that service is still available at that point.

Session recovery loads the Agent’s internal records. Tools observe the external world when that observation is actually needed.

## 13. What If a ToolCall Exists but Its ToolResult Does Not?

Suppose the Event Log before the crash contains:

```json
{
        "type":"tool_call",
        "call_id":"c123",
        "tool":"write_file",
        "path":"main.py"
}
```

Then you pressed Ctrl+C before receiving:

```json
{
        "type":"tool_result",
        "call_id":"c123"
}
```

Two outcomes are possible:

- the file was written successfully, but the result was not persisted in time;
- the program crashed before the tool executed.

Recovery can compare the calls and results:

```python
calls = find_tool_calls(events)
results = find_tool_results(events)

for call in calls:
    if call.id not in results:
        unresolved.append(call)
```

The runtime must not retry automatically. Writing a file, deploying, or creating an Issue can all cause duplicate side effects. Instead, it can record the operation as having an uncertain result and let the corresponding tool verify it when the operation becomes relevant:

```text
SessionManager
    → Finds that c123 has no result
    → Marks it uncertain

WriteFileTool
    → Checks whether the write happened by inspecting the target content or file version
```

Marking it `uncertain` means appending a recovery event:

```json
{
  "type": "tool_recovery",
  "call_id": "c123",
  "status": "uncertain"
}
```

How does SessionManager know that `c123` has no result?

The implicit first step is:

```python
events = load_events(session_id)
```

For example:

```python
with open("events.jsonl") as f:
    for line in f:
        event = json.loads(line)
```

In practice, Resume does not need to scan hundreds of thousands of lines every time. It only needs to locate the final `run_started` and analyze the Events that follow it—although if the file contains only one Run, this still means scanning the whole file. Alternatively, the system can maintain a `runs` table and a `tool_calls` table, then execute only:

```sql
SELECT *
FROM tool_calls
WHERE run_id = 'R105'
AND status = 'pending';
```

This avoids rescanning the history.

How, then, does the LLM learn that a tool did not produce a result?

This is the key point. You can painstakingly water your boss’s flowers, but if your boss never sees it, all that work counts for nothing.

The Harness must tell the LLM while constructing the next Context. The broad flow is:

```text
SessionManager
finds that c123 has no result
        ↓
Produces a structured RecoveryState
        ↓
Context Builder
converts that state into a model message
        ↓
Adds it to the next Context
        ↓
The LLM sees it
```

For example, the Harness obtains:

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

The Context Builder can format it as:

```text
<recovery>
The previous Run was interrupted unexpectedly.

The following tool call has no definitive execution result:

- call_id: c123
- tool: write_file
- target: main.py

It is unknown whether the write completed.
Verify the current state of main.py before depending on it.
</recovery>
```

It can then place this message into the next model input. For example:

```python
template = """
The previous Run was interrupted unexpectedly.

The results of the following operations are unknown:
{uncertain_operations}

Verify their current real-world state before depending on them.
"""
```

Then:

```python
recovery_prompt = template.format(
    uncertain_operations=format_ops(ops)
)
```

## 14. Why Does Each ToolCall Need a Unique Identifier?

Every tool call should have a unique `call_id`:

```text
ToolCall  call_123
    ↓
ToolResult call_123
```

During recovery, the program uses this identifier to determine whether each ToolCall has a matching result.

An operation that causes external side effects may also carry an `operation_id`. If the external service supports idempotent requests, submitting the same `operation_id` more than once produces the effect only once, further reducing the risk of duplicate execution.

But `call_id` and `operation_id` serve different purposes:

- `call_id` associates an internal Agent call with its result;
- `operation_id` prevents an external operation from executing more than once.

## 15. How Does an Agent Detect a Manually Modified File?

Consider a specific scenario:

```text
10:00  read main.py
10:05  the user manually modifies main.py
10:10  the Agent attempts to modify main.py
```

The Agent does not know what happened at 10:05.

There are several common approaches.

### 15.1 Read Again

We can impose one rule: every file write must be preceded by a file read.

Then the logic is not “I know it changed, so I read it again,” but “I read it again, so I now know it changed.”

### 15.2 Version Validation

When reading a file, the tool can also return a content hash:

```json
{
  "content": "...",
  "version": "abc123"
}
```

The write includes that version:

```python
write_file(path="main.py", expected_version="abc123", ...)
```

The tool checks the actual version before writing:

```python
actual_hash = hash(file)

if actual_hash != expected_hash:
    return FILE_CHANGED
```

The LLM does not need to remember that it should reread the file. The tool directly prevents it from overwriting a newer version.

### 15.3 A Patch No Longer Matches

A patch locates a piece of old content and replaces it with new content.

Suppose the original file contains:

```python
def add(a, b):
    return a - b
```

Instead of overwriting the entire file, the Agent uses the `apply_patch` tool:

```diff
-    return a - b
+    return a + b
```

But suppose the user has already changed the function to:

```python
def add(a, b):
    return sum([a, b])
```

The original `return a - b` no longer exists. The patch tool reports:

```text
Patch failed:
old context not found
```

The Agent now knows that the file is no longer the version it previously saw, so it reads the file again.

How does the patch tool know that the patch failed? `apply_patch` reads the file from disk and tries to find `return a - b`. Because the user has modified it, the old content cannot be found and the tool cannot determine where the patch should be applied. The flow is:

```text
The Patch contains a small piece of old content
that describes what the file is expected to look like
        ↓
apply_patch reads the actual file
        ↓
Searches for the old content
        ↓
Found              Not found
  ↓                    ↓
Apply the Patch     Reject the change
```

I will write a separate short article about `apply_patch` later, so I will not expand on it here.

The complete flow is:

```text
The model previously reads main.py
        ↓
Generates a Patch from the content it saw

-old code
+new code
        ↓
Calls apply_patch
        ↓
apply_patch reads the current main.py again
        ↓
Searches for the old code and context described by the Patch
        ↓
Found              Not found
  ↓                    ↓
Apply the Patch     Patch failed
                         ↓
                     Tell the LLM
                         ↓
                     Read the file again
```

A patch therefore does not detect the modification in advance. It detects, at modification time, that “the old content I intended to modify no longer exists.”

This is why an Agent can detect a dirty file even without recovering a session: during normal execution, it rereads or validates the file. The Session recovery mechanism does not inspect the entire project.

## 16. Check Git, Processes, and Ports on Demand as Well

Event history can only describe what the Agent observed in the past. For example:

```text
10:30: the Git branch was main
10:35: process 1234 was running
```

It cannot prove that those states still hold.

When the Git state is actually needed, run:

```bash
git status --porcelain
git branch --show-current
git rev-parse HEAD
```

Only when a Git operation genuinely depends on a prerequisite should the Git tool perform the necessary check. Scanning everything during Resume is unnecessary, as is forcing the LLM to execute a fixed set of Git commands on every turn. That only wastes tokens.

When the Agent actually needs a process, the process tool checks it using the process information the tool saved. SessionManager does not need to understand every command, directory, and port.

In other words, the component that creates and manages a kind of external resource should provide the corresponding validation logic. Session management only persists references and uncertain state; it should not become an enormous decision engine that understands every external system.

## 17. Concurrency Control

Suppose the same Session contains:

- Run A, which is modifying `main.py`;
- Run B, which begins running tests at the same time.

Run B may test code that has only been partially modified, and both Runs may attempt to modify the same file. The simplest reliable strategy for a local Agent is therefore to execute only one primary Run in a Session at a time. New input enters a queue and waits until the current Run finishes. Different Sessions can still run in parallel.

This constraint also simplifies interruption detection: when a new Runtime restores the session and finds that the previous Run is still marked `running`, it can treat that Run as not having ended normally.

## 18. Local Agents and Online Services

A local Agent usually has only one program instance. `session.json` + `events.jsonl`, or a single SQLite database, is enough.

An online service may have many servers. A user’s first request may reach server A, while the next reaches server B. Session state therefore cannot live only on one server’s local disk; it must be stored in durable storage accessible to every instance. This is the familiar backend architecture:

- a database stores Sessions, Runs, and Events that must not be lost;
- Redis stores locks, short-lived caches, running markers, online presence, and other temporary data.

Redis focuses on fast access and coordination across instances. The database focuses on durability, reliability, and queryability. The only complete copy of a session must not live exclusively in an evictable temporary cache.

## 19. A Clear Recovery Flow

A session can be restored with the following minimal flow:

```text
User runs: codex resume xyz123
        ↓
Locate the Session identified by xyz123
        ↓
Read Session information: ID, original workspace, and so on
        ↓
If the current directory differs from the original one,
decide which directory to use for this run
        ↓
Set the Runtime cwd
Future read_file("a.py") and bash("pytest") calls
use this directory by default
        ↓
Read the Session history file
        ↓
Restore the history in the chat interface
        ↓
Read the final Run
        ↓
If it did not finish normally,
mark it interrupted
        ↓
Check whether that Run contains
a ToolCall without a ToolResult
        ↓
If so, record its result as unknown
        ↓
Load additional state such as the Goal and summary
        ↓
Context Builder prepares:
system prompt
+ project instructions
+ Skill
+ Goal
+ history summary
+ recent messages
+ interruption-recovery information
        ↓
Resume completes
        ↓
Wait for the user’s next message
```

Viewed as part of the entire Run, the flow is approximately:

```text
Session/Event data on disk
        ↓
Harness recovery
        ↓
Internal Session State
        ↓
Context Builder
        ↓
LLM
        ↓
ToolCall
        ↓
The Tool queries the real world
        ↓
ToolResult
        ↓
Event Store
        ↓
Enter the next Context
```
