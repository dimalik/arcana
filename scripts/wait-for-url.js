#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { parseArg } = require("./research-test-utils");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const url = parseArg(process.argv, "--url", process.argv[2] || "http://127.0.0.1:3000");
  const timeoutMs = Number(parseArg(process.argv, "--timeout-ms", "180000"));
  const intervalMs = Number(parseArg(process.argv, "--interval-ms", "1000"));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) {
        console.log(`[wait-for-url] ready: ${url} (status ${res.status})`);
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error("[wait-for-url] error:", err?.message || err);
  process.exit(1);
});
