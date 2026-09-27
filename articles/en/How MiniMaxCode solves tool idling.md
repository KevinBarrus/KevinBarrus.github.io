# How MiniMaxCode Solves Tool Idling

Below I walk through a turn from start to finish in chronological order. First, two terms:

- step: the model replies with one message plus executes the tools in that message — that counts as one step. A turn can contain many steps
- turn: from when you send a message to when the model fully stops. Every step in between belongs to this turn

All of the guard's memory exists only within a single turn and is discarded when the turn ends.


## Step 0: Register the hooks at startup

At startup, the runaway-guard extension registers itself in three places (the `init` in `packages/agent-extension/src/runaway-guard.ts`):

- `before_tool_call`: fires before each tool actually executes
- `on_step_end`: fires at the end of each step (corresponding to pi's turn_end event)
- `turn_end`: the whole turn ends, wrap up

What "firing" actually means here: when the runner reaches a certain point, it loops through the functions you registered and calls each one, passing in the current arguments. The function bodies contain the work described later.

There's also a switch: in the config, `enabled` defaults to `true` (`packages/config/src/runaway-guard-config.ts`). When disabled, the guard does nothing and also clears any half-counted tallies.

A note here: an "extension" is really just a JS object with a fixed shape of three things (`packages/agent-runtime/src/types.ts:308`):

```ts
  interface AgentExtension {
    id: string;
    description?: string;
    init(pi: ExtensionAPI): MaybePromise<void>;
  }
```

## Step 1: The model emits a message with tool calls

For example, the model replies:

```text
  calls read({ path: "src/foo.ts" })
```

At this step, pi's loop doesn't check whether the call makes sense; it only runs the tool.


## Step 2: Before the tool runs, the host records "who is calling"

`before_tool_call` fires. It does only one small thing: if this call is for the built-in `task_output`, the host writes down a record that "this was genuinely emitted by the built-in tool" (`trustedTaskOutputProvenance`).

Note: host is the product-layer code in the process running the agent — it provides tools, reads config, manages sessions and storage, and writes logs.

Why record this? Because later, when deciding "is it repeatedly polling a background task", the guard must be able to confirm whether the tool call is real. If the model merely writes "I called task_output" in text, that record won't exist and the guard won't accept it. Otherwise the model could decide what the guard sees, and the judgment would be meaningless.

How exactly is it recorded? Inside the `before_tool_call` handler (`packages/agent-extension/src/runaway-guard.ts:157`):

```ts
  function trustedTaskOutputProvenance(value) {
    const toolCall = value;   // value is event.toolCall, shaped like { id, name, source }
    if (toolCall.name !== 'task_output') return undefined;      // only this tool is handled
    if (toolCall.source === 'builtin') {
      return { toolCallId: toolCall.id, toolName: 'task_output', source: 'builtin' };
    }
    if (toolCall.source === undefined) {
      return { toolCallId: toolCall.id, toolName: 'task_output', source: 'captured-compatibility' };
    }
    return undefined;   // any other source: not recorded
  }
```

Where it's stored: a Map keyed by sessionId + turnId, whose value is `Map<toolCallId, provenance>`.

How it's retrieved: at the end of the step, `takeTrustedToolProvenance` reads and deletes that Map, passing its contents into `guard.observe` as the `trustedToolProvenance` array.

How it's validated: `step-view.ts`'s `trustedToolProvenanceMap` requires: it must be an object; `toolCallId` must actually appear in this assistant message's tool call list; `toolName` must be non-empty; `source` must be one of those two values. The place that actually uses it (`isTrustedNativeTaskOutput`, `tool-policy.ts:117`) further requires all four conditions to match:

```ts
  step.toolName === 'task_output'
  && provenance.toolCallId === step.toolCallId
  && provenance.toolName === 'task_output'
  && (source === 'builtin' || source === 'captured-compatibility')
```

Key point: the model can't fool it by claiming "I called the built-in task_output" in text, because this record is written by the host only right before the tool is actually dispatched. The model can't alter it.


## Step 3: The tool executes and returns a result

After the tool runs, the result may contain:

- an ordinary return value
- an error (e.g. file not found)
- for background tasks, also a status (task state) and next_offset (how far you've read; next time continue from here)

Up to this point, nothing intercepts or tallies anything. The guard doesn't participate in execution decisions: it registers on the pre-execution `before_tool_call` hook, but that handler always returns `undefined` and never intercepts — it only observes.


## Step 4: At the end of the step, the guard turns "actions" and "results" into fingerprints

`on_step_end` fires. The guard gets to work; the first thing it does is compute several "codes" for each tool call in this step (all in `step-view.ts`):

- action code: tool name + arguments, fingerprinted
- result code: the tool's returned content, fingerprinted
- error code: if there's an error, first classify it (timeout / rate limit / network / auth / permission / not found / bad argument / process exit), then fingerprint it; if there's a structured error code, prefer that
- progress code: only computed if the tool itself or the host provides one, e.g. a background task's `{status, next_offset}`

A fingerprint is "assigning an address number to content": same content, same number; different content, different number. It's far shorter than the original and keeps the tool's raw text (which may contain paths, errors, secrets) out of the logs.

For example:

```text
  read({ path: "src/foo.ts" })   → action code A
  read({ path: "src/foo.ts" })   → action code A   ← the same
  read({ path: "src/foo.ts", offset: 100 }) → action code B  ← not the same
```

This step also has two exclusions, to avoid mistaking normal behavior for idling:

- a search finding nothing is not an error: when grep returns "no matches found" or bash returns "command exited with code 1", it's not counted as an error and doesn't enter the error count
- a call blocked by permissions doesn't count: if the model tries to write a file and a policy blocks it, that's the rule disallowing it, not the model going off track — excluded outright

How are they excluded, exactly? All in `packages/agent-modules/runaway-guard/src/step-view.ts`.

Permission blocks: from the `blockedToolCalls` passed in by the runner, pick out the ones blocked by permission and build a set of IDs:

```ts
  const excludedCallIds = new Set(
    blockedToolCalls.filter((call) => call.blockedBy === 'permission').map((call) => call.toolCallId),
  );
```

Then when iterating tool calls, on a hit it does `continue` to skip:

```ts
  if (excluded || policy === 'exempt') continue;
```

The "fake error" of a search finding nothing: if the result `isError` but the tool policy's `isExpectedResult` determines it's an expected result, record this `callId`:

```ts
  if (result?.isError && isExpectedResultBestEffort(configuredPolicy, toolStep)) {
    expectedResultCallIds.add(block.id);
  }
```

Later, when tallying error families, this callId is skipped directly:

```ts
  if (result.isError && policy !== 'exempt' && !expectedResultCallIds.has(result.toolCallId)) { ... }
```

`isExpectedResult`'s implementation just looks at the command and text (`tool-policy.ts:33`): if the bash command starts with `rg`/`grep`/`git grep`, has no compound symbols like `;&|` in its arguments, and the output is "command exited with code 1" or "no matches found", it's accepted.

## Step 5: The guard tallies and decides whether to speak up this step

`signals.ts` does the accumulation: it compares this step's codes against the previously recorded ones, and +1 for the same code.

- same code appearing for the 2nd time: emit an observation signal (only logs and reports);
- 3rd time: trigger a reminder (default threshold 3).

Four kinds can trigger a reminder:

1. repeating the same action
2. repeatedly hitting the same kind of error
3. the progress of the same work object never changing
4. repeatedly checking the same background task whose status never changes

Note: the guard recognizes six signals in total, but only the four above can trigger a reminder. The other two — "the same result repeats" (`exact_result_repeat`) and "actions alternate A, B, A, B" (`abab_action_cycle`, see `observeAbab`) — only emit observations and never inject a reminder.

There's a priority order: unchanged progress > same-kind error > repeated action > polling. When several match at once, pick the first in this order (`reminder.ts:8`).

## Step 6: When it decides to speak, how the message gets in

The guard doesn't interrupt the tool or abort the turn; it does exactly one thing: insert a "user message" into the conversation. The data flow has three steps, all in the code:

Step 1: in `signals.ts`, when a code reaches the threshold, it pushes a "signal kind" (e.g. `exact_action_repeat`) into a Set and returns it. `observeStep` returns that Set.

Step 2: `guard.ts` receives the Set and calls `takePreferredReminder(candidates, ...)`. This function picks one kind from the Set by priority, assembles a string message, and returns `{ content, observation }`.

Step 3: the extension receives that object and pushes it into the conversation (`agent-extension/src/runaway-guard.ts`):

```ts
  event.agent.steer({ role: 'user', content: reminder.content, ... });
```

What `steer` does: it puts this message into pi's pending queue. The model can't see it now, but will see it before the next step begins — after each step, pi drains the pending queue once, inserts the retrieved message into the conversation as a new user message, and then sends another model request.

Two real message examples:

When an action repeats for the 3rd time:

[runaway guard] The immediately repeated tool action has now occurred 3 times with the same arguments. Do not repeat it unchanged. First review the existing results, then either switch to an approach that produces a clear state change, or report the blocker. (`reminder.ts:80`)

When polling a background task for the 3rd time:

The same task's `task_output` has now returned an unchanged status and output position three times in a row. Stop polling; you'll be notified automatically when the task finishes, and the conversation will resume on its own.

Note that it only sends this one message and stops nothing. This is intentional: the guard has no ground truth about the outside world — it can only infer from the "repetition" side, and "repetition" is not the same as "meaningless". The cost of mistaking normal work for idling and blocking it is higher than the cost of missing one case, so it only advises and never kills.

## Step 7: Before the next step, the model sees this reminder

This is the crucial hand-off. After each step, pi's loop drains the pending queue once, inserts the retrieved message into the conversation as a new user message, then sends another model request.

So the history the model sees at the next step looks like this:

```
  assistant: read({path:"src/foo.ts"})
  tool:      Error: no such file
  assistant: read({path:"src/foo.ts"})
  tool:      Error: no such file
  user:      [runaway guard] The same tool action has now been called 3 times with the same arguments...
```

To the model, this reads like the user chimed in mid-work. It usually then stops and changes course, or states the blocker.


## Step 8: Within the same turn, it won't nag repeatedly

There's a one-shot flag: before sending this message, the guard marks "this turn has already been reminded" (`reminderAttempted` at `reminder.ts:31`). So even if this injection fails, it won't retry; even if the model keeps repeating, it won't say it a second time.

Why only once? Because repeated reminders eat context and disrupt the model, and the first message already names the problem. Whatever remains in this turn is handed to the fallback in step 11 below.

## Step 9: When the turn ends, clear memory and produce a report

`turn_end` fires. The guard does two things:

1. generate a summary of this turn: how many steps in total, which signals fired and how many times each, whether a reminder was injected (`state.ts:snapshotTurnSummary`)
2. delete all of this turn's tallies and random keys (`states.delete(key)` in `finishTurn`).

This matters: the guard isn't a global tally but a per-turn temporary record. The next turn starts from zero and won't be misjudged because a previous turn hit a snag.

The summary is sent out via logs and reporting (`observation.ts`), containing only coded fields with no raw tool text. Logs go to local logs (for engineers); reports go to the connected evaluation backend (if this installation has endpoint + token configured; otherwise it just skips and sends nothing). Neither enters the model's context — the model can't see them.

To distinguish: the step-6 `steer` reminder does enter the conversation history (it's a user message); the step-9 observations and summary are pure background data and don't enter the context.

## Step 10: What if the model keeps repeating?

After the reminder is sent, if the model still repeats unchanged, the guard keeps counting and keeps reporting, but won't say a second word. That's why the next layer of fallback is needed.


## Step 11: The fallback when reminders don't work

There are three scenarios where "advising" isn't enough and the machine must be stopped:

① Unattended auto-running goals (Goal mode)

You give it a goal and it runs turn after turn on its own. If 3 consecutive turns end with the same normalized reply fingerprint (ignoring only newlines and leading/trailing whitespace, see `reply-fingerprint.ts`), or 3 consecutive turns call no tool at all (pure empty talk), the goal is paused so it stops burning (default threshold 3, see `packages/config/src/goal-config.ts:66`).

If the host couldn't see whether this turn called any tool, it's counted as "unknown" and the tally resets, rather than being treated as "did no work" — so turns that actually work aren't wronged.

What does "unknown" mean? In the code it's a three-way enum:

```ts
  type ThreadGoalToolActivity = 'used' | 'absent' | 'unknown';
```

- used: this turn really did call a tool
- absent: this turn really called no tool
- unknown: can't tell — the host can't get trustworthy information, so no conclusion

How is it computed? In `threadGoalTurnToolActivity` (`packages/local-runtime/src/thread-goal/turn-work-signals.ts:23`):

```ts
  if (context.accounting.boundTurn.kind !== 'main') return 'unknown';   // not the main execution turn
  if (context.input.status !== 'completed' || context.input.retracted) return 'unknown'; // didn't complete normally
  const observed = context.input.workSignals;
  if (!observed || !Number.isInteger(observed.toolCalls) || observed.toolCalls < 0) {
    return 'unknown';                                                    // no data / invalid data
  }
  return observed.toolCalls > 0 ? 'used' : 'absent';
```

What "unknown" really means: the host didn't observe a trustworthy history for this turn (e.g. the turn was retracted, didn't finish normally, or no work signal was received at all).

How it's handled when scoring:

```ts
  const nextNoToolStreak = input.toolActivity === 'absent' ? state.noToolStreak + 1 : 0;
```

Only `absent` increments the streak by +1; `unknown` goes to the else branch and resets to zero. The reason is stated plainly in the code: `unknown` is an observation gap and must not be stitched into a "consecutive no-work" streak, otherwise it would wrong a turn that actually works.

② The verifier sub-agent

At some stage a Goal dispatches a sub-agent to verify the result. It also runs the agent loop and can also get stuck, so hard limits apply directly: at most N turns, at most N tokens, stop when the line is hit; a single reply is also separately capped on output; it's given only a fixed set of read-only tools. These numbers come from config items; the public default config provides no values, and they're passed only "if present" during assembly.

Four fixed limits always apply: the profile must be the read-only verifier profile (otherwise routing is rejected outright); `web_fetch` / `web_search` are disabled; one verification is capped at 2 physical runs (the first plus a retry to fix the verdict format); and 5 consecutive `not_met` verdicts pause the Goal (`repeatedNotMetLimit` defaults to 5).

③ CLI / headless batch runs

There's a step cap; when reached, it ends (`packages/tui/src/application/run-coordinator.ts`, the termination reason recorded as `max_steps`).

There's also a "watch but don't advise" class: if this turn is a verifier sub-agent running, the guard records signals as usual but won't inject a reminder — because it's a read-only judge and a repeated action isn't necessarily going off track (in `extension.ts`, `shouldRemind: ctx.turnIntent?.kind !== 'goal-verifier'`).


## The whole chain in one sentence

Before the tool runs, the host records a trusted provenance to prevent forgery.

After the tool runs, the guard computes a code each for action, result, error, and progress.

When the same code appears a 3rd time, it injects a reminder into the conversation for the model to see at the next step.

Only once per turn, and it only advises, never blocks.

When the turn ends, clear all tallies and produce a summary.

For scenarios where advising doesn't work (auto-running goals, verifier sub-agents, batch runs), stop it outright with hard caps on turns, tokens, and steps.

A trade-off runs through the whole design: no detected anomaly ever affects tool execution — the worst case is missing one detection, not killing a stretch of normal work.
