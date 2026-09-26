# 插话与待投递消息管理

给会话加一句话有两种时机：**排到下一轮**，或者**在运行中插进当前轮的下一个步骤边界**。
`dsh_send_message` 的 `delivery` 决定用哪一种；另有一组工具用来查看、提前、改写、撤回
**已入队但还没被消费**的消息。

全部能力都直接用 DSH 自己的 Agent inbox 和它自己的队列规则，桥不另建队列，也不靠
`cancel` + 重发伪造插话，更不用手工 splice 冒充 steer。

## 四个工具

| 工具 | 作用 |
|---|---|
| `dsh_send_message` | 投递一句话。`delivery="followup"`（默认）= 排成独立的一轮；`delivery="steer"` = 交给运行中的 agent，在最近一个步骤边界消费 |
| `dsh_list_pending_messages` | 列出已接收但尚未被消费的消息，给出稳定 `message_id`、内容 `version` 与消费顺序。**只读**：冷会话从持久日志读，不会唤醒或恢复 agent |
| `dsh_promote_pending_message` | 把一条**还排在后面轮次**的消息改成插话，交给运行中的当前轮 |
| `dsh_edit_pending_message` / `dsh_withdraw_pending_message` | 改写 / 撤回某条还没被消费的消息 |

## 典型用法

**运行中插话（不打断当前轮）**

```json
{ "session_id": "session-…", "message": "先别改 config.ts，改 src/inbox.ts", "delivery": "steer" }
```

**普通追问（排到下一轮，默认行为，与旧版本完全一致）**

```json
{ "session_id": "session-…", "message": "接着把测试补上" }
```

**发现刚发的那句排错位置，改成插话**

```json
// 1) 看队列，拿到 message_id 和 version
{ "session_id": "session-…" }                       // dsh_list_pending_messages
// 2) 提前它（session 必须在 running）
{ "session_id": "session-…", "message_id": "…", "expected_version": "…" }
```

不需要先撤回再重发。提前走的是 DSH 自己的队列动作：把**同一条消息对象**从 next_turn
移除后用 `agent.steer` 重新投递，所以身份不变、不可能投递两次、DSH 自己的唤醒与取消态
处理照常生效。

顺序上，`agent.steer` 是**追加**到 next-step 尾部。因此按队列顺序连续提前 A、B、C，
得到的就是 `A|B|C`，不会被反转。

## 顺着读返回结果

投递成功返回的是**真实队列状态**，不是"模型已经理解"的承诺：

```json
{
  "session_id": "session-…",
  "accepted": true,
  "message_id": "1f0c…",
  "target": "next-step",
  "delivery": "steer",
  "state": "queued",
  "version": "9a41…",
  "queue": { "nextTurn": 0, "nextStep": 1 },
  "note": "queued for the next step boundary; not yet part of the transcript"
}
```

- `accepted: true` 是**旧接口原样保留**的字段，含义仍然只有"DSH 已入队"。旧客户端只读
  `session_id` + `accepted` 也能继续工作，新增字段是追加的。
- `state: "queued"` 只说明 DSH 把这句放进了待投递列表。
- `target` 是它**实际**落到的队列。若这句在一个正在取消的 turn 之后到达，DSH 会把它停到
  `next-turn`，此时返回的 `target` / `delivery` 会如实反映，而不是照抄请求值。
- `version` 是这条消息内容的摘要（sha256，只暴露摘要）。把它回传成 `expected_version`，
  就能在别的客户端已经改过同一 `message_id` 时拒绝覆盖。
- 真正"进入对话"发生在之后：某个 turn/step 边界把它 claim 进持久记录时。

`dsh_list_pending_messages` 按消费顺序返回：`next_step` 先于 `next_turn`。每条都带
`version`；带附件或非文本块的会标 `non_text: true`；Goal 控制消息会带
`goal_message: { goal_id, revision, stale }`。

## 什么时候会被明确拒绝

不会静默重复投递、不会猜、也不会先删后丢：

| code | 含义 | 该怎么办 |
|---|---|---|
| `MESSAGE_ALREADY_ADMITTED` | 这条已经进入某个步骤、写进对话记录了 | 不能再改；用新的 `dsh_send_message` 补一句 |
| `MESSAGE_NOT_PENDING` | 曾经在队列里，现在没了（被消费 / 被撤回 / 被 cancel 清掉） | 重新 `dsh_list_pending_messages` |
| `MESSAGE_ID_UNKNOWN` | 这个 id 不属于当前会话 | 核对会话与 id |
| `MESSAGE_VERSION_CONFLICT` | 读过之后内容已被（别的客户端）改过 | 重新读一次，用新的 `version` 重试 |
| `MESSAGE_NOT_PROMOTABLE` | 这条已经在 next_step，不是"排在后面轮次"的消息 | 不用提前，它本来就会在下一个步骤边界被消费 |
| `STEER_UNAVAILABLE` | 会话当前不是 running，或该 agent 没有原生 `steer`/`send` 能力 | 先让会话跑起来（`dsh_start_goal` / `dsh_wait_goal`），或等它 running。此检查在**移除之前**完成，消息原地不动 |
| `STEER_REDELIVERY_FAILED` | 原生重新投递抛错 | 看 `details.delivery_status`：`queued` = DSH 仍在队列里（只有一份）；`admitted` = 已进对话记录；`not_delivered` = 未送达，且已按 `details.recovery` 处理 |
| `STEER_RECOVERY_REQUIRED` | 重新投递失败，且**无法证明**已放回原位 | 消息现在不在队列里，`details.text` 带原文供重发；**不要**当成"没丢" |
| `MESSAGE_EDIT_NON_TEXT` | 这条带附件/非文本块，按文本改写会丢数据 | 撤回它，再发一条新的 |
| `GOAL_MESSAGE_PROTECTED` / `GOAL_MESSAGE_STALE` | 这是 Goal 控制消息（或已被后续 revision 取代） | 用 `dsh_update_goal` 改 Goal，不要手改它 |
| `DELIVERY_UNSUPPORTED` | `delivery` 不是 `followup` / `steer` | 改参数；队列未被动过 |
| `INBOX_UNAVAILABLE` | 该会话的 DSH profile 没挂 agent loop，没有 inbox | 该会话不支持排队 |

## 插话失败时会怎样

顺序是：**先核验能力 → 再移除 → 再重新投递**。

1. 能力核验在移除之前。会话不是 running，或 agent 没有原生 `steer`/`send`，直接拒绝，队列一个字节都不动。
2. 移除之后若原生重新投递抛错，**不会**立刻断言"丢了"：DSH 可能出现"已接受投递但后续阶段抛错"的情况，此时重发就会重复。所以先按同一 `message_id` 核验：
   - 仍在队列 → `delivery_status: "queued"`，只有一份；
   - 已被 claim 进对话记录 → `delivery_status: "admitted"`，只有一份；
   - 确实未送达 → 用原生 inbox 把**同一个消息对象**放回原位置，并校验只有一份、位置可证明 → `recovery: "restored"`；
   - 位置已无法证明（原位置被别的消息占了、或 inbox 拒绝插入）→ `recovery: "recovery_required"`，并明说"它现在不在队列里"，同时回传原文供重发。

只有尾部位置能可证明地重放；内部位置一旦列表移动过就不再声称"放回原位"。

## 与 Goal、取消的关系

- **Goal 消息走同一个投递点**，并且固定用 `followup`。这样正式 Goal 元数据和手工排队消息
  看到的是同一个队列、同一个顺序，不会互相矛盾。
- Goal 控制消息**受保护**：编辑、撤回、提前都会被拒，并指向 `dsh_update_goal`。已经被后续
  revision 取代的那条会报 `GOAL_MESSAGE_STALE`，不会被送回当前上下文。
- `dsh_cancel_task` 会按 DSH 自身语义清空**全部**待投递消息并中止当前 turn。
  只想丢掉某一句、保留正在跑的那一轮，用 `dsh_withdraw_pending_message`。

## 实现依据

原生契约来自 DSH 安装版的 `@deepseek-ai/dsh-agent` `Inbox` / `Agent`
（现场 0.1.7-rc.2，仓库锁定 0.1.5-rc.2，两者该接口一致），以及 DSH 自带
session controller 的队列命令（`packages/api/session-controller/src/commands.ts`
的 `updateQueue`）：

- `Agent.send(message, 'next-turn' | 'next-step', wakeup)` —— 唯一的投递原语
- `Agent.followup(m)` = `send(m, 'next-turn', true)`；`Agent.steer(m)` = `send(m, 'next-step', true)`，**追加**到 next_step
- `Agent.inbox.nextTurn` / `.nextStep` / `.hasPending`
- `Agent.inbox.replace(id, m)` / `.remove(id)` / `.splice(...)`
- 队列**编辑只接受文本内容**且必须非空白；编辑用 `freezeMessage` 深冻结
- 把 next_turn 里的条目改成 steer 的前置条件是：条目仍在 `next_turn`，且 `agent.status === 'running'`；
  动作是 `inbox.remove(id)` 然后 `agent.steer(原消息)`
- 两个队列内 id 必须唯一，重复即硬错误；被 claim 的消息以 `user/message` 写进持久记录

对应实现见 [`src/inbox.ts`](../src/inbox.ts) 与 `Bridge.deliverMessage` /
`Bridge.mutatePending` / `Bridge.restorePending` / `Bridge.refuseProtectedGoalMessage`。
可执行证据：
[`test/unit/pending-native-api.test.mjs`](../test/unit/pending-native-api.test.mjs)（原生队列行为）、
[`test/unit/pending-queue.test.mjs`](../test/unit/pending-queue.test.mjs)（桥层行为与全部错误码）、
[`test/unit/pending-mcp.test.mjs`](../test/unit/pending-mcp.test.mjs)（真实 MCP 协议上的旧客户端断言）。
