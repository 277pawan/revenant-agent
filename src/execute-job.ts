import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { access, constants } from "node:fs/promises";

export type ClaimedPayload = {
  job: { id: string; databaseName: string };
  database: {
    host: string | null;
    port: number | null;
    databaseName: string | null;
    username: string | null;
    sslMode?: string | null;
  };
  password: string | null;
  planYaml: string | null;
};

export type CheckResult = {
  checkName: string;
  checkType: string;
  status: "pass" | "fail" | "skip" | "error";
  message: string;
  durationMs: number;
};

export type ExecutionOutcome = {
  status: "pass" | "fail";
  executionMode: "stub" | "agent" | "ci";
  results: CheckResult[];
  errorMessage?: string;
  rtoSeconds: number;
  usedCli: boolean;
};

type CliReport = {
  status?: string;
  checks?: Array<{ name?: string; status?: string; message?: string }>;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve revenant binary: env → PATH → sibling repo binary */
export async function resolveRevenantCli(): Promise<string | null> {
  const fromEnv = process.env.REVENANT_CLI_PATH?.trim();
  if (fromEnv && (await fileExists(fromEnv))) {
    return fromEnv;
  }

  const sibling = resolve(
    process.cwd(),
    "..",
    "..",
    "..",
    "revenant-cli",
    "revenant"
  );
  // cwd may be apps/api or monorepo root
  const candidates = [
    fromEnv,
    sibling,
    resolve(process.cwd(), "../revenant-cli/revenant"),
    resolve(process.cwd(), "../../revenant-cli/revenant"),
    resolve(process.cwd(), "revenant"),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }

  // try PATH
  try {
    await new Promise<void>((ok, err) => {
      const child = spawn("revenant", ["--help"], { stdio: "ignore" });
      child.on("error", err);
      child.on("exit", (code) => (code === 0 ? ok() : err(new Error("no"))));
    });
    return "revenant";
  } catch {
    return null;
  }
}

export function buildDatabaseUrl(claimed: ClaimedPayload): string | null {
  const { host, port, databaseName, username, sslMode } = claimed.database;
  if (!host || !databaseName || !username || !claimed.password) {
    return null;
  }
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(claimed.password);
  const dbName = encodeURIComponent(databaseName);
  const p = port ?? 5432;
  // Cloud stores sslMode (require | prefer | disable | verify-full…). Default require for remote hosts.
  const mode =
    !sslMode || sslMode === ""
      ? host === "localhost" || host === "127.0.0.1"
        ? "disable"
        : "require"
      : sslMode;
  const ssl = mode === "disable" ? "" : `?sslmode=${encodeURIComponent(mode)}`;
  return `postgresql://${user}:${pass}@${host}:${p}/${dbName}${ssl}`;
}

/** Rewrite cloud plan YAML into CLI-shaped config (connection via DATABASE_URL). */
export function buildCliConfigYaml(
  planYaml: string | null,
  planName: string
): string {
  const checksMatch = planYaml?.match(/checks:\s*\n[\s\S]*/i);
  let checksBlock = checksMatch?.[0]?.trimEnd() ?? "";

  if (!checksBlock) {
    checksBlock = "checks:\n  - type: connect";
  } else {
    // Soft-normalize common UI mistakes toward CLI schema fields
    checksBlock = checksBlock
      .replace(/expect_tables:/g, "expect_tables:")
      .replace(
        /(^\s*- type:\s*schema\s*\n)(\s*)tables:/gm,
        "$1$2expect_tables:"
      );
  }

  return [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    "  engine: postgres",
    "  connection: ${DATABASE_URL}",
    "",
    checksBlock,
    "",
  ].join("\n");
}

function runCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function mapCliReport(report: CliReport): CheckResult[] {
  const checks = report.checks ?? [];
  if (checks.length === 0) {
    return [
      {
        checkName: "verify",
        checkType: "verify",
        status: report.status?.toUpperCase() === "PASS" ? "pass" : "fail",
        message: "CLI finished without per-check details",
        durationMs: 0,
      },
    ];
  }
  return checks.map((c) => {
    const name = c.name ?? "check";
    const st = (c.status ?? "FAIL").toUpperCase();
    return {
      checkName: name,
      checkType: name.split(":")[0] ?? "check",
      status: st === "PASS" ? ("pass" as const) : ("fail" as const),
      message: c.message ?? st,
      durationMs: 0,
    };
  });
}

async function runWithCli(
  claimed: ClaimedPayload,
  cliPath: string,
  executionMode: "stub" | "agent" | "ci"
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const databaseUrl = buildDatabaseUrl(claimed);
  if (!databaseUrl) {
    return {
      status: "fail",
      executionMode,
      usedCli: false,
      rtoSeconds: 1,
      errorMessage: "Missing host, database name, username, or password",
      results: [
        {
          checkName: "connect",
          checkType: "connect",
          status: "fail",
          message: "Cannot build DATABASE_URL — configure database credentials",
          durationMs: 0,
        },
      ],
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "revenant-job-"));
  try {
    const configPath = join(dir, "revenant.yaml");
    const reportPath = join(dir, "report.json");
    const yaml = buildCliConfigYaml(
      claimed.planYaml,
      claimed.job.databaseName || "cloud-job"
    );
    await writeFile(configPath, yaml, "utf8");

    const { code, stdout, stderr } = await runCommand(
      cliPath,
      ["verify", "-c", configPath, "-o", reportPath, "--markdown", join(dir, "report.md")],
      {
        cwd: dir,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        timeoutMs: Number(process.env.REVENANT_VERIFY_TIMEOUT_MS ?? 120_000),
      }
    );

    let report: CliReport = {};
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as CliReport;
    } catch {
      report = {};
    }

    const results = mapCliReport(report);
    if (results.length === 0 && (stdout || stderr)) {
      results.push({
        checkName: "verify",
        checkType: "verify",
        status: code === 0 ? "pass" : "fail",
        message: (stderr || stdout).slice(0, 500),
        durationMs: Date.now() - started,
      });
    }

    const failed =
      code !== 0 ||
      report.status?.toUpperCase() === "FAIL" ||
      results.some((r) => r.status === "fail");

    return {
      status: failed ? "fail" : "pass",
      executionMode,
      usedCli: true,
      rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
      errorMessage: failed
        ? (stderr || stdout || "revenant verify failed").slice(0, 500)
        : undefined,
      results,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runMetadataFallback(
  claimed: ClaimedPayload,
  executionMode: "stub" | "agent" | "ci",
  reason: string
): ExecutionOutcome {
  const started = Date.now();
  const hasTarget = Boolean(claimed.database.host && claimed.password);
  const hasPlan = Boolean(claimed.planYaml);
  const simulated = executionMode === "stub";

  const results: CheckResult[] = [
    {
      checkName: "connect",
      checkType: "connect",
      status: hasTarget ? "pass" : "fail",
      message: `${simulated ? "[SIMULATED] " : ""}${
        hasTarget
          ? `Target ${claimed.database.host}:${claimed.database.port ?? 5432} received (${reason})`
          : "Missing host or password"
      }`,
      durationMs: 40,
    },
    {
      checkName: "plan",
      checkType: "plan",
      status: hasPlan ? "pass" : "fail",
      message: `${simulated ? "[SIMULATED] " : ""}${
        hasPlan ? "Validation plan present" : "No validation plan"
      }`,
      durationMs: 10,
    },
  ];

  const failed = results.some((r) => r.status === "fail");
  return {
    status: failed ? "fail" : "pass",
    executionMode,
    usedCli: false,
    rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    errorMessage: failed
      ? simulated
        ? "Stub checks failed (SIMULATED — not a real DB check)"
        : "Agent checks failed (CLI not available)"
      : undefined,
    results,
  };
}

/**
 * Execute a claimed job: prefer real `revenant verify`, else metadata fallback.
 * Stub mode still tries CLI when available so local `npm run dev` can be real.
 */
export async function executeClaimedJob(
  claimed: ClaimedPayload,
  executionMode: "stub" | "agent" | "ci"
): Promise<ExecutionOutcome> {
  const forceSim =
    process.env.REVENANT_FORCE_SIMULATE === "true" ||
    (executionMode === "stub" && process.env.REVENANT_STUB_SIMULATE === "true");

  if (forceSim) {
    return runMetadataFallback(
      claimed,
      executionMode,
      "forced simulation"
    );
  }

  const cli = await resolveRevenantCli();
  if (!cli) {
    return runMetadataFallback(
      claimed,
      executionMode,
      "revenant CLI not found — set REVENANT_CLI_PATH"
    );
  }

  return runWithCli(claimed, cli, executionMode);
}
