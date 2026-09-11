import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_API_URL } from "./api-url.js";
import { resolveRevenantCli } from "./execute-job.js";
import { startRunnerPoll } from "./poll-loop.js";

type AgentConfig = {
  apiUrl?: string;
  token: string;
  pollIntervalMs?: number;
  cliPath?: string;
};

async function loadConfig(): Promise<AgentConfig & { apiUrl: string }> {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i] === "-c") {
      configPath = args[i + 1];
      i++;
    }
  }

  let fileCfg: Partial<AgentConfig> = {};
  for (const p of [configPath, process.env.REVENANT_AGENT_CONFIG, "agent.yaml"].filter(
    Boolean
  ) as string[]) {
    try {
      fileCfg = parseYaml(await readFile(resolve(p), "utf8")) as Partial<AgentConfig>;
      break;
    } catch {
      // next
    }
  }

  const token = process.env.REVENANT_RUNNER_TOKEN ?? fileCfg.token ?? "";
  const apiUrl = (
    process.env.REVENANT_API_URL ??
    fileCfg.apiUrl ??
    DEFAULT_API_URL
  ).replace(/\/$/, "");
  const pollIntervalMs = Number(
    process.env.REVENANT_POLL_MS ?? fileCfg.pollIntervalMs ?? 3000
  );
  const cliPath = process.env.REVENANT_CLI_PATH ?? fileCfg.cliPath;

  if (!token) {
    console.error("Set REVENANT_RUNNER_TOKEN or token in agent.yaml");
    process.exit(1);
  }

  if (cliPath) process.env.REVENANT_CLI_PATH = cliPath;

  return { token, apiUrl, pollIntervalMs, cliPath };
}

async function whoami(apiUrl: string, token: string) {
  const res = await fetch(`${apiUrl}/api/v1/runner/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`whoami failed: ${res.status}`, await res.text());
    process.exit(1);
  }
  return (await res.json()) as {
    identity: {
      runnerId: string;
      databaseId: string;
      name: string;
    };
  };
}

const cfg = await loadConfig();
const { identity } = await whoami(cfg.apiUrl, cfg.token);
const cli = await resolveRevenantCli();

console.log(`[agent] api=${cfg.apiUrl}`);
console.log(
  `[agent] plan="${identity.name}" runner=${identity.runnerId} database=${identity.databaseId}`
);
console.log(`[agent] cli=${cli ?? "not found"}`);

startRunnerPoll({
  apiBase: cfg.apiUrl,
  token: cfg.token,
  executionMode: "agent",
  label: identity.name,
  intervalMs: cfg.pollIntervalMs,
});
