#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.FAKE_DWS_LOG;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify(args)}\n`);
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    JSON.stringify({ authenticated: true, token_valid: true }),
  );
  process.exit(0);
}

if (
  args[0] === "contact" &&
  args[1] === "user" &&
  args[2] === "get-self"
) {
  process.stdout.write(
    JSON.stringify({
      result: [
        {
          orgEmployeeModel: {
            openDingTalkId: "open-owner",
            userId: 10001,
          },
        },
      ],
    }),
  );
  process.exit(0);
}

if (args[0] === "aicard" && args[1] === "lint") {
  process.stdout.write(
    JSON.stringify({
      data: {
        valid: true,
        preflight: { valid: true },
      },
    }),
  );
  process.exit(0);
}

if (
  args[0] === "chat" &&
  args[1] === "message" &&
  args[2] === "send-a2ui-card"
) {
  const content = option("--content");
  if (!content) {
    process.stderr.write("missing --content");
    process.exit(2);
  }
  const messages = JSON.parse(content).map((item) => JSON.parse(item));
  if (messages.length !== 2) {
    process.stderr.write("invalid A2UI message count");
    process.exit(3);
  }
  process.stdout.write(
    JSON.stringify({
      data: { bizId: "biz-dingtalk-test-1" },
    }),
  );
  process.exit(0);
}

if (
  args[0] === "chat" &&
  args[1] === "message" &&
  args[2] === "update-a2ui-card"
) {
  process.stdout.write(JSON.stringify({ result: { updated: true } }));
  process.exit(0);
}

process.stderr.write(`unsupported fake dws command: ${args.join(" ")}`);
process.exit(10);
