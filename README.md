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

### 钉钉卡片审批

项目支持基于本机 `dws` 个人连接发送 A2UI 审批卡片，不需要企业机器人和公网回调地址。先在 `.env` 中设置：

`dws` 是钉钉官方开源的 Workspace CLI，不随钉钉客户端内置。macOS 可安装：

```bash
npm install -g dingtalk-workspace-cli
dws version
```

```bash
APPROVAL_CHANNEL=dingtalk
APPROVER_REF=owner
DINGTALK_BRIDGE_TOKEN=replace-with-another-long-random-token
DINGTALK_DWS_COMMAND=dws
DINGTALK_APPROVER_UID=
```

完成 `dws` 设备登录，然后分别启动控制面、钉钉 bridge 和 Worker：

```bash
dws auth login --device
npm run app
npm run dingtalk:bridge
npm run worker
```

`DINGTALK_APPROVER_OPEN_ID` 是发卡接收人，`DINGTALK_APPROVER_UID` 是回调操作人
校验值；两项留空时会使用当前 `dws` 登录用户。当前 CLI 的卡片回调操作者字段是
`payload.body.operatorDTO.uid`，不是旧示例中的 `openDingTalkId`。卡片按钮携带审批 ID、
动作摘要和批准/拒绝决定；bridge 会在回调控制面前校验钉钉操作人，成功后更新卡片状态。
bridge 应常驻运行，避免点击事件无人消费。

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

Worker 默认使用非交互 Codex 执行。API 提供商可在 Codex 配置或
`CODEX_ENV_ALLOWLIST` 指定的环境变量中设置，不要求 `codex login`：

```bash
WORKER_CODEX_MODE=codex npm run worker
```

本地 Worker 使用 `codex exec` 和
`--dangerously-bypass-approvals-and-sandbox`，因此 Codex 以完全权限静默执行，
不会等待人工审批。控制面仍会对第三方动作执行策略、摘要、审批、租约和验证。
启用前应确认运行账号、工作区和 API 配额可信。

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
- 审批出口支持钉钉 A2UI 卡片和飞书适配器；钉钉依赖本机 `dws` 登录态。
- 飞书回调仍采用可测试的 HMAC 适配协议；生产接入需按实际飞书自建应用协议替换适配器。
- 真实 Codex Runner 使用 `codex exec` 完全权限模式；本机隔离依赖专用 OS 用户、容器或虚拟机。

## 文档

- [实现与验证报告](docs/personal-super-agent-implementation-report.md)
- [架构说明](docs/personal-super-agent-architecture.md)
- [代码实现设计](docs/personal-super-agent-technical-design.md)
- [SQLite + Codex 轻量实现设计](docs/personal-super-agent-sqlite-codex-design.md)
- [架构一致性检查报告](docs/personal-super-agent-conformance-report.md)
