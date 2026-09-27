# MiniMaxCode如何解决工具空转

 下面按时间顺序，把一个 turn 从开始到结束完整走一遍。先约定两个词：

 - step（一步）：模型回一条消息 + 执行这条消息里的工具，算一步。一个 turn 里可能有很多步
 - turn（一轮）：从你发消息开始，到模型彻底停下来为止。中间所有 step 都属于这一轮

 守卫的全部记忆只在一轮之内存在，结束就丢。


## 第 0 步：一开始就登记好监听点

 启动时，runaway-guard 这个扩展在三个位置登记了自己（packages/agent-extension/src/runaway-guard.ts 的 init）：

 - `before_tool_call`：每个工具真正执行之前触发
 - `on_step_end`：每步结束时触发（对应 pi 的 turn_end 事件）
 - `turn_end`：整轮结束，收尾

这里触发实际上就是 runner 走到某个位置时，用一个 for 循环把你注册的那些函数挨个调用一遍，把当时的参数传进去。 函数体里写的就是后面那些工作。

另外还准备了一个开关：配置里 `enabled` 默认是 `true`（`packages/config/src/runaway-guard-config.ts`）。关掉的话，守卫什么也不做，而且会把已经数到一半的计数清空。

这里说明一下，这里所谓扩展其实就是一个 JS 对象。形状固定为三样东西（`packages/agent-runtime/src/types.ts:308`）：

 ```ts
   interface AgentExtension {
     id: string;
     description?: string;
     init(pi: ExtensionAPI): MaybePromise<void>;  
   }
 ```

## 第 1 步：模型吐出一条带工具调用的消息

 比如模型回了：

 ```text
   调用 read({ path: "src/foo.ts" })
 ```

这一步里 pi 的循环不检查"这个调用有没有意义"，它只负责把工具跑起来。


## 第 2 步：工具执行前，host 记一笔"是谁在调用"

 `before_tool_call` 触发。这里只做一件很小的事：如果这次调用的是内置的 `task_output`，host 就在旁边记下一条"这次是内置工具真的发出来的"（trustedTaskOutputProvenance）。

注：host 就是跑 agent 那个进程里的产品层代码，负责提供工具、读配置、管会话和存储、记录日志

为什么要记？因为后面判断"是不是在反复看后台任务"时，必须能确认工具是真是假。如果模型只在文字里写一句"我调用了 task_output"，这条记录不会有，守卫就不认。 否则模型能自己决定守卫看到什么，判断就没意义了。

具体怎么记？就在 `before_tool_call` 的 `handler` 里（`packages/agent-extension/src/runaway-guard.ts:157`）：

 ```ts
   function trustedTaskOutputProvenance(value) {
     const toolCall = value;   // value 就是 event.toolCall，形如 { id, name, source }
     if (toolCall.name !== 'task_output') return undefined;      // 只管这个工具
     if (toolCall.source === 'builtin') {
       return { toolCallId: toolCall.id, toolName: 'task_output', source: 'builtin' };
     }
     if (toolCall.source === undefined) {
       return { toolCallId: toolCall.id, toolName: 'task_output', source: 'captured-compatibility' };
     }
     return undefined;   // 其他来源，不记
   }
 ```

记到哪：一个 Map，key 是 sessionId + turnId，值是 `Map<toolCallId, provenance>`

怎么取出来用：到 step 结束时，`takeTrustedToolProvenance` 读取并删除那个 Map，把内容作为 `trustedToolProvenance` 数组传进
`guard.observe`。

怎么校验：`step-view.ts` 的 `trustedToolProvenanceMap` 要求：必须是对象、`toolCallId` 必须真的出现在这条 assistant 消息的
 `tool call` 列表里、`toolName` 非空、`source` 必须是那两个值之一。最后真正使用它的地方
 （`isTrustedNativeTaskOutput，tool-policy.ts:117`）还要四个条件都对上：

 ```ts
   step.toolName === 'task_output'
   && provenance.toolCallId === step.toolCallId
   && provenance.toolName === 'task_output'
   && (source === 'builtin' || source === 'captured-compatibility')
 ```

关键点：模型不能靠"我在文字里自称我调用了内置 `task_output`"骗过它，因为这条记录只在工具真的被分发前由 host 写下。模型改不了它。


## 第 3 步：工具执行，拿到结果

 工具跑完，结果里可能带：
 - 普通返回值
 - 错误（比如文件不存在）
 - 对后台任务来说，还有 status（任务状态）和 next_offset（你已经读到第几位了，下次从这儿接着读）

 到这一步为止，没有任何东西会拦截或统计。守卫不参与执行决策：它注册在执行前的 `before_tool_call` 钩子上，但那个 handler 永远返回 `undefined`，从不拦截，只是旁观。


## 第 4 步：这一步结束，守卫把"动作"和"结果"翻译成指纹

 `on_step_end` 触发。守卫开始干活，第一件事是给这一步里的每个工具调用算几组"代号"（都在 `step-view.ts` 里）：

 - 动作代号：工具名 + 参数，算一个指纹
 - 结果代号：工具返回的内容，算一个指纹
 - 错误代号：如果报错了，先归类（超时 / 限流 / 网络 / 鉴权 / 权限 / 找不到 / 参数错 / 进程退出），再算指纹；有结构化错误码就优先用错误码
 - 进度代号：只有工具自己或宿主提供了才算，比如后台任务的 `{status, next_offset}`

 指纹就是"给内容发一个门牌号"：内容一样，号码就一样；内容不一样，号码就不一样。比原文短得多，也不会把工具的原文（可能含路径、报错、密钥）带进日志。

 举个例子：

 ```text
   read({ path: "src/foo.ts" })   → 动作代号 A
   read({ path: "src/foo.ts" })   → 动作代号 A   ← 同一个
   read({ path: "src/foo.ts", offset: 100 }) → 动作代号 B  ← 不是同一个
 ```

 这一步还有两个排除项，目的是别把正常行为错当成空转：

 - 搜索没搜到不算错：grep 返回 no matches found、bash 返回 command exited with code 1 时，不算错误，不进错误计数
 - 被权限拦下的调用不算：模型想写文件被策略挡住，这是规则不让，不是模型跑偏，直接排除

具体怎么排除？ 都在 `packages/agent-modules/runaway-guard/src/step-view.ts`。

 权限拦截：从 `runner` 传来的 `blockedToolCalls` 里挑出被权限挡下的，做成一个 ID 集合：

 ```ts
   const excludedCallIds = new Set(
     blockedToolCalls.filter((call) => call.blockedBy === 'permission').map((call) => call.toolCallId),
   );
 ```

 然后遍历工具调用时，命中就 continue，跳过：

 ```ts
   if (excluded || policy === 'exempt') continue;
 ```

 搜索没搜到的"假错误"：如果结果 `isError`，但工具策略的 `isExpectedResult` 认定这是预期结果，就把这个 `callId` 记下来：

 ```ts
   if (result?.isError && isExpectedResultBestEffort(configuredPolicy, toolStep)) {
     expectedResultCallIds.add(block.id);
   }
 ```

 后面统计错误家族时，这个 callId 直接跳过：

 ```ts
   if (result.isError && policy !== 'exempt' && !expectedResultCallIds.has(result.toolCallId)) { ... }
 ```

 `isExpectedResult` 的实现就是看命令和文本（`tool-policy.ts:33`）：bash 开头是 `rg/grep/git grep`、参数里没有 `;&|` 这类复合符
 号、输出是 `command exited with code 1` 或 `no matches found`，就认。

## 第 5 步：守卫数数，决定这一步要不要说话

 `signals.ts` 负责累加：把这次的代号和之前记下的比，同一个代号就 +1。

 - 同一个代号第 2 次出现：发一条观测信号（只写日志并上报）；
 - 第 3 次出现：触发提醒（默认阈值 3）。

 能触发提醒的有四类：

 1. 同一个动作反复做
 2. 同一类错误反复撞
 3. 同一个工作对象的进度一直没变
 4. 同一个后台任务反复看、状态始终没变

 注意：守卫一共识别六种信号，但只有上面这四种能触发提醒。另外两种——"同一个结果反复出现"（`exact_result_repeat`）和"动作按 A、B、A、B 来回换"（`abab_action_cycle`，见 `observeAbab`）——只发观测，永远不插提醒。

 顺序上有个优先级：进度没变 > 同类错误 > 动作重复 > 轮询。同时命中多个时，按这个顺序挑第一个（`reminder.ts:8`）。

## 第 6 步：决定说话时，怎么把话递进去

 守卫不打断工具、不中止这一轮，它只做一件事：往对话里插一条"用户消息"。数据流分三步，都在代码里：

 第一步：`signals.ts` 里发现某个代号达到阈值，就往一个 Set 里塞一个"信号种类"（比如 `exact_action_repeat`），然后返回这个 Set。`observeStep` 返回的就是它。

 第二步：`guard.ts` 拿到这个 Set，调用 `takePreferredReminder(candidates, ...)`。这个函数按优先级从 Set 里挑一个种类，拼出一段字符串文案，返回 `{ content, observation }`。

 第三步：扩展拿到这个对象，把它塞进对话（`agent-extension/src/runaway-guard.ts`）：

 ```ts
   event.agent.steer({ role: 'user', content: reminder.content, ... });
 ```

 steer 的作用是：把这条消息放进 pi 的等待队列。模型现在看不到，但**下一步**开始前会看到——pi 每步结束后会去取一次等待队列，把取到的消息当成一条新的 user 消息塞进对话，然后再发一次模型请求。

 举两个实际文案的例子：

 动作重复到第 3 次时：

[runaway guard] 同一个工具动作已经连续 3 次用同样的参数调用。
不要再原样重复。先看已有的结果，然后要么换一个能带来明确状态变化的做法，要么把这个卡点报告出来。

对应的英文原文是（`reminder.ts:80`）：

[runaway guard] The immediately repeated tool action has now occurred 3 times with the same arguments. Do not repeat it unchanged. ...

轮询后台任务到第 3 次时：

同一个任务的 `task_output` 已经连续三次返回了没变的 status 和输出位置。别再轮询了；任务完成时会自动通知你，对话也会自动继续。

注意这里只发了这一条，没有停任何东西。这是有意的：守卫没有外部世界的 ground truth，它只能从"重复"这个侧面推断，而"重复"不等于"无意义"；把正常干活误判成空转、然后拦掉它的代价，比漏判一次更高，所以它只劝不杀。

## 第 7 步：下一步开始前，模型看到了这条提醒

 这是关键的衔接点。pi 的循环每步结束后会去取一次等待队列，把取到的消息当成一条新的 user 消息塞进对话，然后再发一次模型请求。

 所以模型**下一步**看到的历史是这样的：

 ```
   assistant: read({path:"src/foo.ts"})
   tool:      Error: no such file
   assistant: read({path:"src/foo.ts"})
   tool:      Error: no such file
   user:      [runaway guard] 同一个工具动作已经连续 3 次用同样的参数调用……
 ```

对模型来说，这就像是用户在它干活中途插了句话。它通常会因此停下来换路子、或者把卡点说出来。


## 第 8 步：同一轮里，它不会反复唠叨
 
有个一次性开关：守卫在发出这条消息之前就标记"这轮已经提醒过了"（`reminder.ts:31 的 reminderAttempted`）。所以哪怕这次注入失败，也不会重试；哪怕模型继续重复，也不会再说第二次。

为什么只提醒一次？因为反复提醒会挤占上下文、干扰模型，而且第一句已经点明了问题。同一轮里剩下的问题，交给下面第 11 步的兜底机制。

## 第 9 步：整轮结束，清空记忆、出一份报表

`turn_end` 触发。守卫做两件事：

 1. 生成一份这轮的汇总：一共走了多少步、触发过哪些信号各几次、有没有注入过提醒（`state.ts:snapshotTurnSummary`）
 2. 把这轮的计数和随机密钥全部删掉（`finishTurn` 里 `states.delete(key)`）。

这很重要：守卫不是全局统计，而是一轮一份临时记录。下一轮从零开始，不会因为上一轮踩过坑就误判这一轮。

汇总会通过日志和上报发出去（`observation.ts`），里面只有代号化的字段，没有工具原文。日志发给本地日志（工程师看），上报发给接入的评测后端（如果这个安装配了 endpoint + token；没配就直接跳过，什么也不发）。 两者都不进模型上下文，模型看不到。

 区分一下：第 6 步那条 steer 提醒是**进对话历史**的（它是一条 user 消息）；这里第 9 步的观测和汇总才是纯后台数据，不进上下文。

## 第 10 步：如果模型一直重复呢？

提醒发完之后，如果模型还是原样重复，守卫会继续数数、继续上报，但不会再说第二句。这就是为什么需要下一层兜底。


## 第 11 步：提醒不管用时的兜底

 有三种场景，"劝"不够，要把机器停下来：

 ① 无人值守自动跑的目标（Goal 模式）

你给一个目标，它会自己一轮一轮跑。如果连续 3 轮最终回复的规范化指纹相同（只忽略换行和首尾空白，见 `reply-fingerprint.ts`），或者连续 3 轮一个工具都没调（纯说空话），就把目标暂停，不再烧（默认阈值 3，见`packages/config/src/goal-config.ts:66`）。
 
如果宿主没看到这轮到底调没调工具，算"看不清"，计数清零，而不是当成没干活，不冤枉能干活的轮次。

什么叫看不清？ 程序里它是一个三选一的枚举：

 ```ts
   type ThreadGoalToolActivity = 'used' | 'absent' | 'unknown';
 ```

 - used：这轮确实调用了工具
 - absent：这轮确实一个工具都没调
 - unknown：看不清——host 拿不到可信信息，所以不下结论

 怎么算出来的？在 `threadGoalTurnToolActivity`（`packages/local-runtime/src/thread-goal/turn-work-signals.ts:23`）：

 ```ts
   if (context.accounting.boundTurn.kind !== 'main') return 'unknown';   // 不是主执行轮
   if (context.input.status !== 'completed' || context.input.retracted) return 'unknown'; // 没正常完成
   const observed = context.input.workSignals;
   if (!observed || !Number.isInteger(observed.toolCalls) || observed.toolCalls < 0) {
     return 'unknown';                                                    // 没拿到数据/数据不合法
   }
   return observed.toolCalls > 0 ? 'used' : 'absent';
 ```

 看不清的真正含义是：host 没有观察到这轮的可信历史（比如轮次被撤回、没正常结束、或者根本没拿到工作信号）。

 它在计分时的处理是：

 ```ts
   const nextNoToolStreak = input.toolActivity === 'absent' ? state.noToolStreak + 1 : 0;
 ```

 只有 absent 才连击 +1；unknown 走 else，清零。原因代码里写得很直白：unknown 是观察缺口，不能被拼成一段"连续没干活"，否则会冤枉一个能干活的轮次。

 ② 验证子代理
 Goal 跑到某个阶段会派一个子代理去验证结果。它同样跑 agent 循环，同样可能卡住，所以直接上硬限制：最多几轮、最多多少 token，到线即停；单次回答还单独限输出量；只给它固定的几个只读工具。这些数字来自配置项，公开的默认配置里没有给值，拼装的时候也是”有才传“。

 始终生效的固定限制有四条：profile 必须是只读的 verifier profile（否则直接拒绝路由）；禁用 `web_fetch` / `web_search`；一次验证最多 2 次物理运行（第一次 + 补 verdict 格式的重试）；验证连续 5 次判 `not_met` 会把 Goal 暂停（`repeatedNotMetLimit` 默认 5）。

 ③ CLI / headless 跑批
 有步数上限，到点就结束（`packages/tui/src/application/run-coordinator.ts`，终止原因记为 `max_steps`）。

还有一类是只看不劝：如果这一轮是验证子代理在跑，守卫照常记录信号，但不会插提醒。因为它是只读的裁判，重复动作不一定是跑偏（`extension.ts` 里 `shouldRemind: ctx.turnIntent?.kind !== 'goal-verifier'`）。


## 整条线一句话串起来

 工具执行前，host 记下可信来源，防止伪造。
 
 工具执行后，守卫把动作、结果、错误、进度各算一个代号。
 
 同一个代号第 3 次出现，就在对话里插一条提醒，让模型下一步看到。
 
 一轮只插一次，并且只劝不拦。
 
 整轮结束，清空所有计数，出汇总。
 
 劝不动的场景（自动跑的目标、验证子代理、跑批），用轮数、token、步数这些硬上限直接停。

 贯穿始终的一个取舍是：所有判断检测出任何异常都不影响工具执行，最坏情况是漏判一次，而不是错杀一段正常干活。