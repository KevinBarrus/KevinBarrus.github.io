## 1. Why Context Management Exists

The model has no memory. Every request has to carry the system prompt + the entire message history + tool definitions, all sent over again. And the model's window is finite — what it can see in a single request is limited — and once you exceed the window size, the request fails outright.

That is why context management is needed: message history can grow without bound, but a single request cannot.

Context does not bloat uniformly. Among everything that makes up the context, tool output is by far the largest. In a task like "read 20 files, then modify code," tool output can account for over 90%. So the compaction strategy should not spread its effort evenly — it should focus on tool output.

On top of that, mainstream providers today all have prefix caching: if the request prefix is unchanged, the request is cheap. This means any operation that modifies the historical prefix carries a hidden cost — it's not just "shorter means cheaper"; a broken cache means the whole prefix gets recomputed at full price. This fact directly shaped my harness's firewall and eviction designs — and even led to one failed experiment.

## 2. Pre-Request Checks

User input first goes through a front check: `validate_user_input` confirms that a single user message can fit into the budget on its own. If it can't, the input is rejected outright with a hint to "save it as a file and send the path" rather than truncating the user's request:

```python
        try:
            context_manager.validate_user_input(prompt)
        except UserInputTooLarge as exc:
            screen.add_entry(
                "tool",
                f"Input too large ({exc.estimated_tokens}/{exc.max_tokens} tokens). "
                "Save large text as a workspace file and send its path instead.",
            )
            screen.restore_submitted_draft()
            return
```

Then, inside the AgentLoop.run() loop, before every model request, `build_context` is called to assemble the context that will be sent to the model:

```python
for force_compaction in (False, True):
    if build_context is not None:
        context_result = await build_context(context, force_compaction)
        request_messages = context_result.messages
    try:
        ... # call the model
    except AgentError as exc:
        if exc.category != "context_overflow" or force_compaction:
            raise
```

## 3. The Compaction Record

Suppose the JSONL holds 500 messages. Before some request, the estimate says sending everything would exceed the window, so the first 400 messages are compacted into a summary, and only "summary + the last 100 messages" is actually sent.

But ten minutes later, another model request is needed. Now the question: how does `ContextManager` know the first 400 messages have already been summarized? The model server remembers nothing — it sees exactly what you send this time. If nobody remembers the conclusion of the last compaction, this request would have to re-estimate all 500 messages and re-summarize them: every request would waste another summarization call, and the summary would come out different each time.

So the conclusion of a compaction must be persisted. That persisted thing is the compaction record: `CompactionRecord`, with exactly three fields:

```python
@dataclass(frozen=True)
class CompactionRecord:
    summary: str                    # the summary text
    first_kept_message_index: int   # index in the full history from which original messages are kept (e.g. 400)
    tokens_before: int              # estimated token count before compaction (for UI display)
```

It is appended to the session file as one JSON line with `type: "compaction"`. Note: it is not a message — it is an annotation line, recording "original messages only exist from message 400 onward; everything before that lives in summary."

Here is one of my real compaction records (contents elided for brevity):

```JSONL
{
    "type": "compaction", 
    "summary": "
        ## Goal\n- Original task: ...\n- User background: ...\n- User pain points: ...\n\n
        ## Progress\n...\n\n
        ## Key Decisions\n...\n\n
        ## Next Steps\n1. ...\n\n
        ## Critical Context\n...\n\n
        <read-files>\n- ...\n</read-files>\n\n
        <modified-files>\n\n</modified-files>",
    "first_kept_message_index": 85, 
    "tokens_before": 84672
}
```

How is the record used on the next request?

Before every request, `build_for_model_result` (called inside `build_context`, the core of context assembly) receives two things: the complete message history + the list of compaction records. It then calls `_apply_latest_compaction`:

```python
latest = compactions[-1]                    # take the newest compaction record
kept_messages = messages[latest.first_kept_message_index:]   # the original messages to keep
return system + [Conversation summary:\n{latest.summary}] + kept_messages
```

The output is the list actually sent to the model this time. What the model sees is "system messages + 1 summary message + the kept original messages."

#### Follow-up: as history grows longer, does first_kept_message_index change with it?

Yes — and it is recomputed on every compaction.

First, get the causality right: `first_kept_message_index` is not an input that decides how much original text to keep; it is the result recorded *after* the retained segment has been selected. What decides how much to keep is the `keep_recent_tokens = 20000` budget. During compaction, the retained messages are selected by budget first (see Section 6 for how), and only then is the index of the selected segment's starting point in the full history written into the compaction record.

Now use a timeline to see what happens between two compactions. Suppose the first compaction is the real one shown above:

Compaction 1 (history: 93 messages): estimate 84,672 > 84,000 — triggered. Filling 20k from the newest backward selects the 8 messages at indices 85–92 → record A is persisted: `first_kept = 85`.

Every subsequent request: view = summary A + all original messages after index 85. Each new message makes the view grow a little.

When history reaches 200 messages: view = summary A + the 115 original messages at indices 85–199. Those 115 messages grow past the 84,000 estimate (assume 115 messages trigger compaction) → compaction 2 is triggered.

Compaction 2: same function again, filling 20k from the newest backward. This time the candidates are only indices 85–199 (everything before 85 was already swallowed by summary A); say it selects the 28 messages at 172–199 → record B is persisted: `first_kept = 172`.

When generating B's summary, A's summary is passed in as part of the input (`_summary_source`, the cumulative summary), so the information before index 85 lives on inside B's summary.

From then on, every request: view = summary B + original messages after index 172. Record A never participates in assembly again. Only `compactions[-1]` — the newest record — is ever used; A stays in the file purely as an archive. The starting index of a new record can only move backward-to-forward (at compaction 2, all candidates come from after the old starting index 85, so the new index is necessarily ≥ 85); monotonic increase is guaranteed structurally, not by luck.

So whether history grows to 10,000 or 100,000 messages, what the model sees at any moment is "one summary + roughly the most recent 20k of original text" — it always fits in the window.

One-sentence summary: the compaction record is a persisted annotation of the compaction's conclusion. History is never rewritten; every assembly is a view replayed on the spot from "the full history + the newest annotation."

## 4. Assembly and Turnover Within a Turn

Within one Turn, `AgentLoop` typically requests the model many times (a new request after each round of tool calls), and before every request the outgoing messages must be assembled — done by the injected `build_context` callback (mentioned above):

```python
new_compactions = []          # compaction records generated this turn, not yet written to file

async def build_context(messages, force_compaction: bool):
    result = await context_manager.build_for_model_result(
        client_holder.client,
        messages,
        [*session.get_compactions(), *new_compactions],   # ← the key line
        ...
    )
    if result.compaction is not None:
        new_compactions.append(result.compaction)          # ← the key line
    return result
```

The inputs and outputs of `context_manager.build_for_model_result`:

```
Inputs: full history messages + compaction record list + eviction record list
Output: ContextBuildResult
        .messages    → the message list sent to the model this time (system + summary + retained originals)
        .compaction  → the newly produced compaction record (if compaction happened), otherwise None
        .eviction    → the newly produced eviction record (if eviction triggered)
```

Internally it does five things in order:

```text
raw history + existing compaction records + existing eviction records
        ↓ 1. replay the view (_apply_latest_compaction ∘ _apply_evictions)
   the current model-visible view
        ↓ 2. eviction check (off by default)
        ↓ 3. build(): estimate ≤ threshold? → return directly
        ↓ over → 4. compact (summarize)
        ↓ summary failed → 5. rule-based trimming fallback
```

By outcome, this collapses into three branches:

- Within budget (the overwhelming majority): prepend the system prompt and return directly — no compaction
- Over: run the compaction flow — first select the retained segment, then fire a separate, independent model request to generate the summary from the old messages being hidden (`generate_context_summary`; this is the only action that genuinely "hands compression to the model", and it is a tiny request: the summary prompt + the old messages serialized into plain text). On success, return "summary + retained originals"
- Summary failed: rule-based trimming fallback

Now the two key lines marked in the code:

- The second argument passes in the persisted old compaction records **concatenated with** the in-memory new records from this turn. Why concatenate: suppose the first request of this turn triggers compaction and produces a new record. By the second request, that record has not been written to file yet (`session.get_compactions()` doesn't contain it) — if it isn't concatenated in, `ContextManager` will assume compaction never happened and process the full 500-message history all over again
- When compaction succeeds, the new record is first stashed in `new_compactions`

Only when the whole `agent_loop.run()` finishes does it get persisted:

```python
_persist_new_messages(session, result.new_messages)   # first write this turn's new messages
_persist_compactions(session, new_compactions)        # then write the compaction records
```

`_persist_compactions` is just a loop calling `session.add_compaction` per record, appending to the JSONL. Afterwards, even if the process restarts, `Session.restore()` reads back the messages and compaction records and rebuilds the exact same view.

Why is the concatenation mandatory? Walk a numeric timeline (500 messages of history, 3 tool calls this turn, i.e. 4 model requests):

Request 1:

```text
build_for_model_result(500 messages, compactions=[])
→ estimate 90k, over 84k
→ compact: produce record A (first_kept=430, with summary)
→ return "summary + originals after message 430" and send to the model   ← the model gets on with its work
→ ui stashes A into new_compactions = [A]
```

Note that at this moment A exists only in the in-memory list, not in the JSONL; persistence waits until the entire `agent_loop.run()` finishes.

Request 2 (tools finished; history grew to 505 messages):

```text
Passed correctly: compactions = session.get_compactions() + new_compactions = [] + [A] = [A]
     → assemble under the state where A exists: "summary + originals after message 430" ✓

Passed wrongly (only session.get_compactions(), = []):
     → ContextManager sees an empty list → "never compacted"
     → takes the full 505-message history → estimate over again → compaction triggers again
     → another summarization call is paid for, producing a redundant record B
     → and the just-generated A was wasted
```

That is what "assumes it was never compacted" means: it isn't amnesia — its worldview is determined entirely by its parameters. Pass an empty list, and A does not exist in its world.

One-sentence summary: `ContextManager` is stateless; its worldview is determined entirely by the lists passed in on each call. So within a Turn, compaction results circulate through the in-memory list, and persistence happens in one batch at the end of the Turn: on read, concatenate the in-memory new records; on write, accumulate until the wrap-up.

## 5. How Tokens Are Estimated

Three numbers make up the budget model:

```python
DEFAULT_CONTEXT_BUDGET = ContextBudget(100_000, 16_000, 20_000)
# context_window=100k, reserve_tokens=16k, keep_recent_tokens=20k
# compaction_threshold = 100k - 16k = 84k
```

`reserve_tokens` is headroom for model replies; `keep_recent_tokens` is how much recent original text compaction keeps. Note the budget counts more than messages: `_message_budget` subtracts the tool-definition JSON and the system messages, and each message carries an extra 4-token protocol overhead (`MESSAGE_PROTOCOL_TOKENS`).

The first level of estimation is character-based (`estimate_text_tokens`): wide characters (CJK, emoji) count as 1 token each, everything else as 1 token per 4 characters. No tokenizer dependency — good enough, and a pure function that's easy to test.

The second level is real-usage backfill: replacing local estimates with the exact usage returned by the server. Why this is needed starts from the check that happens before every request:

### Follow-up: every request requires checking the total against the limit — does that mean old messages' tokens get recomputed every time?

To spell out the question: suppose after one compaction `first_kept_message_index` is 85 and history has grown to 99 messages. Before the next request we must check how many tokens "system content + summary + all originals after message 85" total, and whether that exceeds 84k. The check needs the token count of each message. So messages 86–99 — long since stored, possibly long since estimated — do they get run through the character formula again on every request? The system prompt and the compaction summary, present in every single request, get recomputed every round? The longer the history, the bigger this duplicated work snowballs?

First, one easily overlooked fact: the model is requested far more often than user messages arrive. In the Agent Loop, a model reply may carry tool calls — once tools finish and results are appended to history, the model is immediately requested again, with no new user message in between. Twenty rounds of tool calls in a Turn means twenty model requests. Put differently: every assistant message in the history is the product of one model request; as many assistant messages as exist, that many requests happened.

Second, correct one common confusion: when compaction does not trigger, the step "select retained messages backward from the end" does not exist at all. Backward selection to fill 20k runs only at the moment compaction triggers; everyday requests send all originals after `first_kept_message_index` as-is, and the check only totals them. And when totaling, old messages' tokens do not need recomputation — the answer hides in the return value of every model response.

Every server response carries the real usage of that request: how many input tokens were consumed (prompt_tokens) and how many were produced (completion_tokens). We record these numbers, together with a hash fingerprint of that request's input, on the assistant reply of that very request, and persist them with the message. Note they can only live on assistant messages: usage is the server's report for "one request," produced only at the moment the model replies — tool and user messages never carry this field.

A real example:

```JSONL
{
    "type": "message", 
    "role": "assistant", 
    "content": "", 
    "reasoning": "The user wants to see which dependencies pyproject.toml declares. This is a read-only operation. Let me locate the file first.", 
    "tool_calls": [
        {
            "call_id": "call_00_4GCXbAQHDAl52xsrdA757676", 
            "name": "list_files", 
            "arguments": {"path": "."}
        }, 
        {
            "call_id": "call_01_HK2A0dGBClzwa19drjsO0065", 
            "name": "read_file", 
            "arguments": {"path": "pyproject.toml"}
        }
    ], 
    "usage": {
            "prompt_tokens": 2004, 
            "completion_tokens": 94, 
            "total_tokens": 2098, 
            "cached_tokens": 640, 
            "cache_miss_tokens": 1364
        }, 
    "request_fingerprint": "d1fafe052c4d98b6a2c203f6376f37c2c26c4f68fd71af17da4a07861bb59cee"
}
```

On the next estimation, walk backward from the newest message to the most recent assistant message carrying usage (call it the anchor), hash the messages before the anchor again, and compare against the stored fingerprint: if the fingerprints match, that prefix has not changed by a single byte since that request (new messages only get appended after the anchor and cannot touch what precedes it), so the exact value the server counted back then is directly the token count of this prefix. Hence:

```text
estimate for the next request = prompt_tokens stored on the anchor message (exact, covers everything before the anchor)
                                + character estimate of the anchor message itself (it was that request's "output", not inside its own prompt_tokens)
                                + character estimate of the few new messages after the anchor
```

```text
Request N goes out
    ↓
Model replies with an assistant message ("I need to look at this file", carrying tool_calls: read_file) ← this is the anchor
    ↓
 Tools execute
    ↓
Tool results appended as tool messages (role="tool")   ← they come after the anchor
(3 parallel tools = 3 tool messages)
    ↓
Before request N+1 (to tell the model the tool results), total is estimated  ← now 1–3 tool messages sit after the anchor
```

Because every round of tool calls refreshes the anchor, the anchor is usually only one or two messages away from the newest. What each request actually has to compute by itself is just that short tail.

prompt_tokens is a cumulative value, not a delta: request N's input already contains everything from all previous rounds, so you only ever need the most recent value — never a sum over history.

The fingerprint check also guards against a pitfall for free: once a prefix has been replaced by a compaction summary or rewritten by eviction, the fingerprint stops matching immediately, the old usage is automatically invalidated, and estimation falls back to full character-based counting.

Only two situations still require per-message recomputation:

One: the request that triggers compaction and must reselect the retained segment — but compaction happens once per dozens of tool-call rounds, a low-frequency cost.

Two: no usable usage can be found (e.g. the session's very first request, or right after a compaction when no request has happened yet and all old anchors' fingerprints have gone stale).

On the everyday path, the token computation done per request is constant: just the few new messages after the anchor — no matter how long the history grows.

## 6. How Compaction Cuts: Conversation Groups and Tool Chains

First, establish the correct causality: `first_kept_message_index` is not an input deciding how much original text to keep — it is the result recorded after the retained segment is selected; what decides how much to keep is the `keep_recent_tokens = 20000` budget. The retained originals are selected by budget first; only then is the starting index of the selected segment in the full history written into the compaction record.

`select_recent_messages` does not cut at individual messages. It first splits the history into conversation groups at user-message boundaries (`_conversation_groups`), then takes whole groups backward from the newest:

```python
groups = _conversation_groups(conversation_messages)   # split into groups at user-message boundaries

selected_groups = []
selected_tokens = 0
for group in reversed(groups):                         # walk backward from the last group
    group_tokens = _estimate_messages(group, ...)
    if selected_groups and selected_tokens + group_tokens > max_tokens:
        break                                          # one more group would exceed 20k — stop
    selected_groups.append(group)                      # still within 20k: take the whole group
    selected_tokens += group_tokens                    # update the retained token count
```

`max_tokens` is `min(keep_recent_tokens, message budget) ≈ 20k`. Groups are packed one by one from the newest backward until adding the next group would exceed 20k.

Then the selected segment's starting point is converted into an index in the full history — that is where the field in the compaction record comes from:

```python
def _first_message_index(messages, selected_messages):
    selected_ids = {id(m) for m in selected_messages}
    for index, message in enumerate(messages):     # count from the head of the full history
        if id(message) in selected_ids:
            return index                           # index of the earliest selected message
```

Why whole groups: an assistant's tool_call and the corresponding tool result must appear as a pair. Cutting between them produces an invalid message sequence that the server rejects outright.

Two companion functions handle boundary cases:
- `_has_valid_tool_chain`: checks that call_ids and results are paired in both directions.
- `_remove_unpaired_tool_messages`: after fallback trimming, removes orphaned calls/results.

An oversized single turn is a special case (added in v2): the latest turn alone exceeds `keep_recent_tokens`; keeping it whole breaks the budget, dropping it whole loses the request. `_split_oversized_latest_turn` searches backward from the turn's tail for the longest suffix that is "within budget and tool-chain complete" to keep as originals, and generates a separate prefix summary for the front part. What the model ends up seeing: the cumulative history summary + this turn's prefix summary + this turn's suffix originals.

## 7. Asking the Model to Summarize Part of the Context

Fire one independent model request that turns the old messages being hidden into a written summary. In the real `CompactionRecord` shown earlier, the text in the summary field starting with `## Goal\n- Original task: read the current project…` is exactly the output of such a request.

Say the messages being hidden are indices 0–84. A few things happen:

1. The 85 messages are serialized into plain text (`_serialize_messages`):
   [user] Help me sort out this project's context management
   [assistant] Let me first look at the directory structure
   [tool_call] list_files({"path": "."}) id=call_01_xxx
   [tool] src/ design/ tests/ ...
   ...(all 85)

2. Wrapped into a new request:
   system: You are a context summarization assistant.
           Generate a structured summary based only on the given history; do not continue answering questions from the history.
           You must strictly include these headings: ## Goal / ## Progress / ## Key Decisions / ## Next Steps / ## Critical Context
   user:   <conversation>(the text of the 85 messages above)</conversation>

3. The model's reply text = the summary, stored into the `CompactionRecord`

This is a tiny request completely separate from the main conversation — the main conversation waits for it to finish before continuing. That simple. But with only the bare action, three pitfalls appear:

Pitfall 1: on the second compaction, the first summary gets thrown away → cumulative summary

Compaction 1: messages 0–84 become summary S1. Compaction 2: the hidden messages are 85–171. If only 85–171 are handed to the model, nobody owns S1. S2 describes only 85–171, while "what the user originally wanted" exists only in S1. After two compactions, the earliest task goal vanishes entirely from the model's world — it starts answering the wrong question.

Fix: prepend S1 as the first message before 85–171 and let the model produce a "merged" S2. The earliest goal is passed down the chain this way — lossy, but it never disappears no matter how many compactions happen.

Pitfall 2: the model doesn't write a summary — it continues the work → structural validation

What you hand the model is a chunk of conversation text, and the model's natural tendency is to continue that conversation. If the hidden history ends with "help me read pyproject.toml," the model may well reply: "The dependencies are: openai, prompt-toolkit…". That is not a summary — it did the user's job. Stuff that back into context and the model will later treat it as "something I said"; the task goes off the rails.

Fix: two gates. The first sits in the prompt ("do not continue answering questions from the history" + the five headings). The second sits in code (`_is_structured_summary` checks that all five heading strings are present); if incomplete, it's judged a failure and retried once with a stricter retry prompt.

The real summary shown earlier — starting with `## Goal`, all five sections present — is exactly what these two gates filter for.

Pitfall 3: the summary won't keep track of file paths for you → the file manifest

The hidden old messages contain many `read_file`/`edit_file` calls. Summaries tend to record "what was decided" ("adjusted the config loading logic") rather than enumerate paths ("modified config.py and settings.py").

Consequence: after the second compaction, the model goes on to modify `config.py` — but it doesn't know it already modified that file last round or to what state, because that information is in the hidden originals.

Fix: don't hand this to the model at all. `_collect_file_operations` scans the entire history in code, collects and deduplicates the paths of successful reads/writes, then pins two blocks onto the end of the summary by plain string concatenation:

```text
<read-files>
- pyproject.toml
- src/core/context.py
</read-files>

<modified-files>
- src/core/ui.py
</modified-files>
```

Whether a tool "is a file read/write tool" is decided by the `capability` metadata on the tool definition (file.read/file.write), not by hard-coded tool names — so custom file tools plugged in via MCP are also counted. Deterministic information (path lists) is guaranteed by deterministic means (code scanning); the model only does what it's good at: semantic summarization.

The summary request's own input also has a budget. The original approach: take half the message budget (≈40k); on overflow, send only the most recent chunk into the summary request and declare the omission up front. The mechanism itself is right — the summary request is also a model request, and its input cannot be unbounded — the problem lies in the number "half."

The discovery started with one sentence in a real summary: "the original task description was omitted and cannot be recovered from the current history." Working the numbers backward: when compaction triggers, the total is about 84k; after keeping the recent 20k, the compacted part starts at 64k+ — naturally nearly double the 40k budget.

In other words, "exceeding the summary budget" is not an edge case but **the norm of every compaction**: in that real compaction, the 85 hidden messages (67 of them tool output) estimated at about 80k, the summary request received only the most recent ~40k, the task's starting point at the very front was cut, the model never saw it and could only honestly declare "cannot recover." Nor is this a one-time loss — every compaction loses once; the front half of the compacted history never reaches the summary.

Later, two things were changed:

1. The budget changed from "half the message budget" to floor(0.85 × window) minus a summary-output reserve. The compacted part typically runs 64k–80k; the new budget fits it whole — a normal compaction omits nothing. The 15% headroom instead of going all the way to the cap: character estimation runs low on source-code-like text; one bad estimate and the summary request dies with a hard 400 — and this is precisely the request that rescues an over-limit session, so headroom is mandatory. But 15% is enough; the original 50% was not needed.
2. When it truly doesn't fit (the compacted part exceeds the new budget — only extremely long sessions), instead of "send only the recent chunk + declare omission," it now folds: split into as many windows as fit by message boundaries, summarize window by window, with each later window's input carrying the summary produced by the previous window, updating iteratively. If the server reports an overflow, halve the window size and retry, with a floor of 16k.

After the change, neither case loses content anymore: normal compaction (the vast majority) sends everything — that "original task description was omitted" sentence will not appear again; extremely long sessions take the folding path, where the cost changes from "losing the front half of the information" to "a few extra summary requests." The omission declaration now survives for exactly one scenario: a single message that by itself exceeds the budget (say the user pasted a huge file) — there it truncates that one message proportionally and declares, instead of giving up the whole stretch of history.

## 8. Failed Summaries Are Not Persisted

When the summary fails twice (`ContextSummaryError`), `build_fallback` takes over: deterministic rule-based trimming (keep system + recent messages + insert an explicit note that "earlier history was omitted because summarization failed"), and no compaction record is written at all. On the next request — or when the session is restored — the summary is attempted again from the full history, because a single network failure should not permanently lose the early history. Degradation under failure is temporary; it must not be frozen into fact.

## 9. The Three Context-Reduction Mechanisms

There are three places where context gets reduced: the firewall, eviction, and compaction. Compaction was the protagonist of Sections 3–8; this section puts the three side by side.

**Firewall: before tool output enters history.** A tool finishes; its result is about to become a message in history. First, measure its length (`apply_output_firewall`): if a single output exceeds 8,000 characters, the full text is stored under the harness runtime directory at `/artifacts/<session>/`, and only a preview — the first and last 10 lines — plus one retrieval line (`Full output: artifact://3`) goes into context; when the model needs the full content, it reads it back with the ordinary `read_file`. At or below 8,000 characters, it enters history as-is.

The firewall must happen before the message enters history, never rewritten afterwards. The reason is prefix caching: rewriting mid-history breaks the cache at unpredictable positions, while finalizing before entry means the cache can only break at the natural boundary of "a new message was appended."

**Eviction: before a model request, when the total exceeds the eviction threshold.** Stale tool outputs in history (never user messages or model replies) are batch-replaced with placeholders, using the same on-disk mechanism as the firewall. Off by default. Three constants govern its behavior:

- EVICTION_TARGET_RATIO = 0.65: once triggered, drop in one shot to 65% of the threshold — no hovering at the line re-triggering over and over;
- EVICTION_MIN_SAVINGS_TOKENS = 4_000: if the projected saving is under 4,000 tokens, don't evict — don't break the cache for pocket change;
- KEEP_RECENT_TOOL_OUTPUT_TOKENS = 16_000: the most recent 16k tokens of tool output are protected, never evicted.

A natural question: eviction rewrites the historical prefix — doesn't that break the prefix cache?

It does, necessarily — and that is exactly why eviction is off by default. One break costs a full-price recomputation of the missed portion, so the whole design revolves around "break less": don't evict when projected savings are under 4,000 tokens (the saving can't pay for the break), drop to 65% of the threshold on trigger (no hovering and re-triggering), and produce exactly one atomic record per trigger (no per-round drift).

Even so, a mis-set threshold still means a net loss. Measured: cache hit rate down 20.9 percentage points, total tokens up 64% — that is the story of Section 10.

**Compaction: before a model request, when the total exceeds 84k.** Old messages are swapped for a summary, keeping the most recent 20k of originals — everything covered in the preceding sections.

The three compared:

| | Firewall | Eviction | Compaction |
|---|---|---|---|
| When | right after a tool runs, before the result enters history | before a request, total over the eviction threshold | before a request, total over 84k |
| Acting on | this one oversized output | stale tool outputs in history | old conversation messages (by group) |
| How | full text to disk, preview + retrieval line | full text to disk, placeholder | rewritten into a summary by the model |
| Can the original come back? | yes (read_file retrieves it) | yes (read_file retrieves it) | no (only the summary remains) |
| Costs a model request? | no | no | yes (the summary request) |
| Currently on? | on | off by default | on |

Why three instead of one: each covers a different situation, at different cost.

The firewall covers "one single item is too big": no model request, lossless, finalized before entering history — but it can only intercept the one item just produced.

Eviction covers "many medium-sized items accumulating into too much": likewise no model request, lossless — but off by default (see the experiment in Section 10).

Compaction covers "the whole thing is just too big": the last resort — it costs a summary request and is lossy; once the originals become a summary, they don't come back.

The full path of one tool output: pass the firewall (8,000 characters) and enter history; before every model request, check the eviction threshold first (skipped by default), then the compaction threshold.

## 10. A Negative Experiment: One "Optimization" Raised Cost by 64%

**Setup**: the same three-stage long task, the same model, run twice — E0 with eviction off (control), E1 with eviction on and the eviction threshold set to 20k.

| Metric | E0 (off) | E1 (on, 20k) |
|---|---:|---:|
| Total tokens | 1,134,610 | 1,862,158 (+64.1%) |
| Cache hit rate | 93.7% | 72.8% (−20.9 points) |
| Cache-missed tokens | 72k | 507k (7×) |
| Eviction triggers | 0 | 51 |
| Stages passed | 3/3 | 3/3 |

Identical task results, cost up 64% — strictly counterproductive.

Why 51 triggers? Two factors stacked:

First, the 20k threshold sat far below the task's real context peak (measured later: 42,717). Through the mid-to-late task, context hovered above 20k — every step crossed the line.

Second, the first version of eviction behaved "gradually": each trigger only brought the estimate down to **just below the threshold**, then stopped. So the loop: drop to 19k → the model works a few more steps → climbs back above 20k → trigger again → drop a little more → … 51 triggers = 51 prefix rewrites = 51 cache breaks, and the tokens saved nowhere near paid for the missed re-computation.

In other words, the three constants in Section 9 (hysteresis 0.65, savings gate 4,000, protection 16k) were not part of the original design — they were added after this failed experiment, learned the hard way: hysteresis fixes "hovering at the line and re-triggering"; the savings gate fixes "breaking the cache for pocket change."

**How the new threshold was set: offline replay.** Three steps:

1. While E0 ran, the complete message history of every step was archived.
2. A script reads that archive and walks the task from beginning to end — no model requests, no tool executions. This works because the eviction decision is pure computation: given (current history, threshold), it computes whether this step triggers and what gets evicted. How the context grew did depend on the model — but E0's archive already contains every real response; replay them as recorded.
3. Sweep different thresholds, counting triggers per setting:

| Threshold | 20k | 32k | 38k | 40–42k | 43k |
|---|---:|---:|---:|---:|---:|
| Projected triggers | 26 | 9 | 6 | 2 | **0** |

The peak was 42,717: a threshold above the peak (43k) never triggers; any threshold below the peak necessarily re-triggers, and every trigger is a cache break.

**After the constants were fixed**, there was a sequel. The plan was to pay for another real run (E2) to validate the new constants — but the offline sweep made that experiment meaningless.

E2 was meant to measure "the cost and benefit of eviction," which requires eviction to actually happen a few times so the treatment and control groups behave differently. The sweep computed two things: first, the table above — when each threshold setting crosses the line; second, **how much could be saved at most once over the line** — hypothetically degrade every eviction candidate and compute the before/after estimate difference. The second result: on this trajectory the eviction candidates were naturally few (the most recent 16k of tool output is protected, and outputs over 8,000 characters had long since been turned into placeholders by the firewall) — degrading all candidates could only save 2,054 tokens. That number is decided by the candidate pool, independent of the threshold — meaning that no matter which threshold, no matter how many crossings, every eviction plan saves ≤ 2,054, below the 4,000 savings gate: the gate always blocks. Combining both: under every threshold setting, actual evictions are zero.

Zero actual evictions means: paying for E2 would produce two identically-behaving groups; the result would be pure noise, answering nothing. Under the pre-agreed constraint "spend money only after the offline sweep passes," the paid experiment simply doesn't run.

Predicting "this experiment isn't worth running" at zero cost — that is the value of offline replay: what it buys is not the common sense "a threshold above the peak never triggers," but the numbers nobody knew in advance: what the peak is, how many times each threshold setting triggers, and how much can be saved at most when triggered.

**Conclusion**: eviction's benefit is sending N fewer tokens; its cost is a full-price recomputation of M missed tokens after one cache break. Net = N − M, and below the real peak, M crushes N. Hence eviction stays off by default; to enable it, the threshold must first be measured against the real peak via offline replay — never set by gut feeling.
