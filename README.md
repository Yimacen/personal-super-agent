# Personal Super Agent

单用户、本地优先的个人超级助理基线。当前已实现 SQLite 控制面、持久 Job、Codex Worker 协议、动作摘要、策略审批、一次性租约、独立验证和任务审计时间线。

## 快速开始

```bash
cp .env.example .env
# 修改 .env 中的 INTERNAL_API_TOKEN
npm install
npm run migrate
npm run app
```

另开终端启动确定性 Worker：

```bash
npm run worker
```

提交一个测试事件：

```bash
curl -X POST http://127.0.0.1:4310/api/events \
  -H 'content-type: application/json' \
  -d '{
    "source": "todo",
    "eventType": "todo.update_requested",
    "subjectKey": "todo:inbox/item-1",
    "idempotencyKey": "todo:item-1:done:2026-11-17",
    "occurredAt": "2026-11-17T09:00:00+08:00",
    "summary": "Mark item-1 as done",
    "sensitivity": "private"
  }'
```

使用真实 Codex 前先登录，并将 Worker 模式改为 `codex`：

```bash
codex login
WORKER_CODEX_MODE=codex npm run worker
```

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run demo
```

迁移和备份：

```bash
npm run migrate
npm run backup
```

## 当前边界

- 控制面与 SQLite 只支持单主机、单写者。
- 内置 `MemoryConnector` 用于确定性验证，尚未接入真实日历、邮件或 GitHub。
- 飞书回调采用可测试的 HMAC 适配协议；生产接入需按实际飞书自建应用协议替换适配器。
- 真实 Codex Runner 已实现启动检查和 CLI 调用，但本机当前未登录，因此尚未完成真实模型复验。
- Codex 的强隔离仍需专用 OS 用户、容器或虚拟机，不能只依赖 `workspace-write`。

## 文档

- [实现与验证报告](docs/personal-super-agent-implementation-report.md)
- [架构说明](docs/personal-super-agent-architecture.md)
- [代码实现设计](docs/personal-super-agent-technical-design.md)
- [SQLite + Codex 轻量实现设计](docs/personal-super-agent-sqlite-codex-design.md)
- [架构一致性检查报告](docs/personal-super-agent-conformance-report.md)
