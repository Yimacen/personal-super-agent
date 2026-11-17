# 个人超级助理本地基线实现与验证报告

> 验证日期：2026-11-17  
> 实现范围：SQLite 控制面 + Codex Worker 协议 + 动作审批/租约/验证纵向切片  
> 对应设计：
> [架构说明](./personal-super-agent-architecture.md)、
> [轻量实现设计](./personal-super-agent-sqlite-codex-design.md)

## 1. 结论

SQLite + Codex 的轻量方案可行，本地基线已经实现并通过自动化测试与端到端演示。

已验证的核心闭环为：

```text
事件接收 -> 幂等去重 -> 持久化 Job -> Codex Worker 领取
-> 结构化动作提议 -> 确定性策略 -> 自动执行或审批
-> 一次性租约 -> 执行回执 -> 独立读回验证
-> Codex 最终自检 -> 完成任务与审计时间线
```

当前实现是单用户、本地优先的工程基线，不是完整生产系统。真实 Codex CLI 当前未登录；确定性 Scripted Worker 已完整验证，真实 Codex 模式会被启动前检查阻止，直到执行 `codex login`。

## 2. 文档复核发现与改进

### 2.1 必须补充的通知事务边界

轻量设计的 DDL 没有 Outbox 表，但流程要求生成审批后发送飞书卡片。若在 SQLite 事务中直接发送外部通知，会违反“禁止在事务中调用第三方 API”的约束；若先提交审批再发送且进程崩溃，则会留下从未展示给用户的待审批动作。

实现采用 `jobs` 表作为事务性 Outbox：

- 审批记录、动作状态和 `send_approval` Job 在同一事务提交。
- 飞书发送在事务外执行，失败可重试。
- 卡片发送成功后写审计事件。

### 2.2 Worker 结果重试需要独立幂等键

仅依赖 HTTP 请求幂等不足以覆盖“动作已经创建，但 Worker 在收到响应前崩溃”的场景。

实现增加：

- `agent_results(run_id UNIQUE)`：同一 Codex Run 的最终结果只能处理一次。
- `actions.agent_run_id UNIQUE`：同一 Run 最多创建一个动作。
- 重复提交结构化结果时返回已有处理结果，不重复创建动作或租约。

### 2.3 执行 Job 的恢复不能只依赖 Job 租约

外部动作可能已经生效，但本地在保存回执前崩溃。简单把过期 Job 重新置为 `pending` 会导致重复副作用。

实现采用以下规则：

- 租约已 `claimed` 但动作没有回执时，动作进入 `outcome_unknown`。
- 只创建独立验证 Job，通过连接器读回状态。
- 不在未知状态下重新调用执行接口。
- 如果读回证明动作成功，则继续最终自检；否则任务失败。

### 2.4 Worker Job 重试不能限制为单个 Run

如果 `agent_runs.job_id` 唯一，过期 Job 恢复后无法创建新的作用域 Run。

实现允许一个 Job 在恢复后创建新 Run，同时撤销旧 Run Token，并继续使用同一 Job 持久状态。

### 2.5 最终完成必须等待 Codex 自检

独立连接器验证通过只能证明外部状态正确，不能替代任务验收标准检查。

实现增加 `final_check` Run：

1. 连接器执行后读回。
2. 独立验证器写入 `verifications`。
3. 验证通过后创建最终自检 Worker Job。
4. Codex 收到只读验证证据，不得再提议新动作。
5. 最终 Result 通过严格 Schema 后任务才进入 `completed`。

### 2.6 外部通知签名需要通过适配器确认

当前 `/api/feishu/callback` 使用以下测试协议：

- HMAC-SHA256；
- `${timestamp}.${canonicalJson(body)}` 作为签名内容；
- 5 分钟重放窗口；
- 审批人、动作摘要、状态和事件 ID 校验。

这不是对特定飞书租户应用配置的最终兼容声明。接入真实飞书自建应用时，需要按实际卡片回调和事件订阅协议替换签名适配器，并保留相同的领域校验与幂等边界。

## 3. 代码结构

```text
src/
├── app/          Fastify API、Zod 请求校验、控制面 Job 调度
├── connectors/   连接器端口、注册表和确定性内存连接器
├── db/           SQLite Schema、迁移、完整性检查、备份
├── domain/       工作区无依赖的模型、策略、状态机和 Codex 输出 Schema
├── lib/          ID、规范 JSON、摘要、时间和签名工具
├── notifications/飞书通知适配器
├── services/     事件、任务、动作、审批、执行和审计服务
└── worker/       Worker HTTP 客户端、任务工作区和 Codex Runner
```

依赖检查确认：

- `domain` 不依赖 Fastify、SQLite、连接器或飞书。
- `worker` 不导入数据库、动作授权、租约签发或审批服务。
- 只有控制面打开 SQLite 连接并执行写入。
- Worker 只使用短期 Run Token 调用当前 Run 的内部接口。
- 每个任务通过 `task_accounts` 获得显式来源账号授权；Worker 上下文不会包含该任务未授权的其他应用账号。

## 4. 已实现能力

| 能力 | 状态 | 实现位置 |
| --- | --- | --- |
| SQLite WAL、外键、STRICT、`user_version` | 已实现 | `src/db/` |
| 备份与完整性检查入口 | 已实现 | `npm run backup` |
| 事件去重与持久 Job | 已实现 | `src/services/control-plane.ts` |
| `BEGIN IMMEDIATE` 原子领取 | 已实现 | Worker/Control Job claim |
| 短期 Run Token 与任务作用域 | 已实现 | `run_tokens`、内部 API |
| 任务级来源账号最小授权 | 已实现 | `task_accounts` |
| 任务工作区隔离 | 已实现 | `src/worker/workspace.ts` |
| Codex 结构化输出严格校验 | 已实现 | `src/domain/codex-result.ts` |
| 动作规范化与 SHA-256 摘要 | 已实现 | 控制面动作服务 |
| 风险策略与 Kill Switch | 已实现 | `src/domain/policy.ts` |
| 审批记录与签名回调 | 已实现测试协议 | `src/app/server.ts` |
| 一次性执行租约 | 已实现 | `execution_leases` |
| 执行回执与独立验证 | 已实现 | 执行 Job + 验证 Job |
| `outcome_unknown` 对账 | 已实现 | 执行恢复路径 |
| Worker/Job 租约恢复 | 已实现 | `recoverExpiredLeases()` |
| Codex 最终自检 | 已实现 | `final_check` Run |
| 用户可读任务时间线 | 已实现 JSON API | `/api/tasks/:id/timeline` |
| Scripted Worker | 已实现 | 不调用模型，用于确定性验证 |
| 真实 Codex CLI Runner | 已实现，待登录复验 | `src/worker/codex-runner.ts` |

## 5. 自动化验证

执行：

```bash
npm run typecheck
npm test
npm run build
npm run demo
```

当前结果：

- TypeScript 严格模式检查通过。
- 生产构建通过。
- 13 项自动化测试通过。
- 独立演示任务进入 `completed`，待办读回状态为 `done`。
- 真实进程联调通过：Fastify 控制面与独立 Worker 通过 HTTP 完成初始 Run 和最终自检，任务进入 `completed`。

测试覆盖：

1. Schema 版本、STRICT、外键、WAL 和完整性。
2. 同一 Webhook 并发重放只生成一个事件、任务和 Worker Job。
3. 并发 Worker 领取不会拿到同一个 Job。
4. 过期 Worker 租约被恢复时撤销旧 Token，并生成新 Run。
5. 可逆私有写入只执行一次，独立验证和最终自检后完成。
6. 外发动作等待摘要绑定审批，审批回调重放只执行一次。
7. 签名正确但动作摘要不匹配的审批被拒绝。
8. 已写入但回执丢失时进入不确定状态，通过读回完成，不重复写入。
9. Kill Switch 阻止写入。
10. Codex 输出未知字段被严格 Schema 拒绝。
11. Domain 与基础设施依赖边界。
12. Worker 不依赖数据库、策略或审批服务。
13. 内部接口需要控制面 Token，Run Token 只能访问绑定的 Run。

## 6. 仍待完成的生产事项

### 6.1 真实 Codex 登录与复验

当前 `codex login status` 返回 `Not logged in`。Worker 在 `WORKER_CODEX_MODE=codex` 下会拒绝启动，避免未认证进程领取任务。

完成方式：

```bash
codex login
WORKER_CODEX_MODE=codex npm run worker
```

登录后应补一次真实模型 Run，确认：

- `thread.started` 或 CLI 等价事件能提取线程标识。
- 真实输出满足严格 Schema。
- 最终自检任务不会重复提议动作。

当前真实 Runner 使用固定版本的本地 Codex CLI，并通过 `--output-schema`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules` 和 `workspace-write` 约束执行。设计文档推荐 SDK；若后续切换 SDK，应保持相同的 Runner 接口、环境变量白名单、工作区和 Schema 约束。由于当前使用 `--ephemeral`，任务恢复依赖持久工作区和 SQLite 事实源，而不是依赖可恢复的 Codex Thread。

### 6.2 操作系统级隔离

`workspace-write` 限制写入范围，但不能单独证明 Codex 无法读取同一 OS 用户可见的 SQLite、Vault 或用户 Home。生产部署应使用：

- 专用 OS 用户；
- 容器或虚拟机；
- 只挂载当前任务目录；
- 独立网络策略。

### 6.3 真实连接器与 Device Daemon

当前只有确定性 `MemoryConnector`。尚未接入日历、邮件、GitHub、飞书或本地设备执行，也尚未实现 `read_connector` 多轮数据请求。`needs_data` 结果会安全地暂停任务，而不是继续猜测。

### 6.4 飞书生产协议

需要接入真实自建应用，完成：

- 卡片交互回调验签/解密适配；
- 用户身份映射；
- 卡片状态更新；
- 过期与替换卡片；
- 回调来源 IP、Token 或平台要求的额外校验。

### 6.5 SQLite 运维上限

当前设计适用于单主机、单控制面写者和低并发。出现跨主机、多用户常态并发或持续写锁超时后，应迁移 PostgreSQL。

### 6.6 尚未实现的交互与补偿能力

- 飞书“修改后批准”尚未实现；当前只支持批准和拒绝，修改必须生成新动作与新摘要。
- 动作取消、自动补偿和人工恢复入口尚未接入 API。
- `needs_data` 已有安全暂停边界，但尚未实现受限连接器读取循环。
- 长期记忆、真实 Webhook 验签和 OAuth 凭据托管尚未接入。
