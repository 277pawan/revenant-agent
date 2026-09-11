/**
 * Revenant Agent Box — separate product from Revenant Cloud.
 *
 * This is NOT "npm run agent inside cloud". It is its own app you install on a
 * customer machine (or CI). Cloud website only creates the token; this process
 * does the heavy work.
 *
 *   cp agent.example.yaml agent.yaml   # paste apiUrl + token from Settings
 *   npm install && npm start
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveRevenantCli } from "./execute-job.js";
import { startRunnerPoll } from "./poll-loop.js";

type AgentConfig = {
  apiUrl: string;
  token: string;
  kind?: "agent" | "ci";
  pollIntervalMs?: number;
  cliPath?: string;
};

function usage(): never {
  console.error(`Revenant Agent Box

Usage:
  npm start -- --config ./agent.yaml
  REVENANT_API_URL=... REVENANT_RUNNER_TOKEN=rvn_... npm start

This app talks to Revenant Cloud over HTTP (claim / complete).
Keep it running as a service. Website users only click Run.
`);
  process.exit(1);
}

async function loadConfig(): Promise<AgentConfig> {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i] === "-c") {
      configPath = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage();
    }
  }

  let fileCfg: Partial<AgentConfig> = {};
  const candidates = [
    configPath,
    process.env.REVENANT_AGENT_CONFIG,
    "agent.yaml",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      const raw = await readFile(resolve(p), "utf8");
      fileCfg = parseYaml(raw) as Partial<AgentConfig>;
      console.log(`[agent-box] loaded config ${resolve(p)}`);
      break;
    } catch {
      // try next
    }
  }

  const apiUrl = (
    process.env.REVENANT_API_URL ??
    fileCfg.apiUrl ??
    ""
  ).replace(/\/$/, "");
  const token = process.env.REVENANT_RUNNER_TOKEN ?? fileCfg.token ?? "";
  const kind =
    (process.env.REVENANT_RUNNER_KIND as "agent" | "ci" | undefined) ??
    fileCfg.kind ??
    "agent";
  const pollIntervalMs = Number(
    process.env.REVENANT_POLL_MS ?? fileCfg.pollIntervalMs ?? 3000
  );
  const cliPath = process.env.REVENANT_CLI_PATH ?? fileCfg.cliPath;

  if (!apiUrl || !token) {
    console.error(
      "[agent-box] Missing apiUrl/token. Copy agent.example.yaml → agent.yaml or set env vars."
    );
    usage();
  }

  if (cliPath) {
    process.env.REVENANT_CLI_PATH = cliPath;
  }

  return { apiUrl, token, kind, pollIntervalMs, cliPath };
}

const cfg = await loadConfig();
const cli = await resolveRevenantCli();

console.log(`[agent-box] api=${cfg.apiUrl}`);
console.log(
  `[agent-box] cli=${cli ?? "not found — set cliPath / REVENANT_CLI_PATH for real verify"}`
);
console.log(
  "[agent-box] Keep this process running. In Revenant Cloud, users only click Run."
);

startRunnerPoll({
  apiBase: cfg.apiUrl,
  token: cfg.token,
  executionMode: cfg.kind === "ci" ? "ci" : "agent",
  label: "agent-box",
  intervalMs: cfg.pollIntervalMs,
});
