import { spawn } from "node:child_process";
import {
  access,
  constants,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectHttpHealthSpecs,
  runHttpHealthChecks,
  stripHttpHealthFromChecksBlock,
} from "./http-health-checks.js";

export type RecoveryMode = "direct" | "aws-rds";

export type AwsRecoveryConfig = {
  engine: "aws-rds";
  sourceIdentifier: string;
  region: string;
  useFreetier: boolean;
  sandboxInstanceClass: string | null;
};

export type RunnerAwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type ClaimedPayload = {
  job: { id: string; databaseName: string };
  database: {
    engine: "postgres" | "mysql";
    host: string | null;
    port: number | null;
    databaseName: string | null;
    username: string | null;
    sslMode?: string | null;
    recoveryMode?: RecoveryMode;
  };
  password: string | null;
  recovery: AwsRecoveryConfig | null;
  awsCredentials: RunnerAwsCredentials | null;
  planYaml: string | null;
  contractHealthcheck?: { url: string } | null;
  fullDrill?: boolean;
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

export type RunnerProgressStage =
  | "runner_starting"
  | "resolving_cli"
  | "checking_source"
  | "creating_snapshot"
  | "waiting_for_snapshot"
  | "selecting_snapshot"
  | "restoring_sandbox"
  | "waiting_for_sandbox"
  | "connecting_sandbox"
  | "running_checks"
  | "cleaning_sandbox"
  | "reaping_sandboxes";

export type ReportRunnerProgress = (
  stage: RunnerProgressStage,
  message: string,
  checks?: Array<{
    checkName: string;
    checkType: string;
    status: "pass" | "fail" | "skip";
    message: string | null;
  }>
) => Promise<void>;

type CliReport = {
  status?: string;
  checks?: Array<{ name?: string; status?: string; message?: string }>;
  recovery?: {
    snapshot_identifier?: string;
    snapshot_arn?: string;
    temporary_instance_identifier?: string;
    expires_at?: string;
    cleanup_status?: string;
    cleanup_error?: string;
  };
};

const AWS_VERIFY_TIMEOUT_MS = Number(
  process.env.REVENANT_AWS_VERIFY_TIMEOUT_MS ?? 2_100_000
);
const DIRECT_VERIFY_TIMEOUT_MS = Number(
  process.env.REVENANT_VERIFY_TIMEOUT_MS ?? 120_000
);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function isLocalCliOverrideAllowed(): boolean {
  const value = (process.env.REVENANT_ALLOW_LOCAL_FALLBACK ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function buildReleaseAssetName(version: string): string | null {
  const normalizedVersion = version.replace(/^v/, "");
  const platform = process.platform;
  const arch = process.arch;

  const osName =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "darwin"
        : platform === "win32"
          ? "windows"
          : null;

  if (!osName) return null;

  const archName =
    arch === "x64"
      ? "amd64"
      : arch === "arm64"
        ? "arm64"
        : arch === "arm"
          ? "arm64"
          : null;

  if (!archName) return null;

  const suffix = osName === "windows" ? "zip" : "tar.gz";
  return `revenant_${normalizedVersion}_${osName}_${archName}.${suffix}`;
}

async function installLatestRevenantCli(): Promise<string | null> {
  const repo = process.env.REVENANT_CLI_REPO ?? "277pawan/revenant-cli";
  const targetDir = process.env.REVENANT_CLI_DIR ?? resolve(process.cwd(), ".revenant-bin");
  const releaseVersion = process.env.REVENANT_CLI_VERSION ?? "latest";
  const version = releaseVersion === "latest"
    ? await fetch(`https://api.github.com/repos/${repo}/releases/latest`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`github release lookup failed: ${res.status}`);
          const json = (await res.json()) as { tag_name?: string };
          if (!json.tag_name) throw new Error("latest release tag missing");
          return json.tag_name;
        })
        .catch(() => null)
    : releaseVersion;

  if (!version) return null;

  const assetName = buildReleaseAssetName(version);
  if (!assetName) return null;

  await mkdir(targetDir, { recursive: true });
  const installDir = targetDir;
  const archivePath = join(installDir, assetName);
  const archiveUrl = `https://github.com/${repo}/releases/download/${version}/${assetName}`;
  const archiveResponse = await fetch(archiveUrl);
  if (!archiveResponse.ok) {
    return null;
  }

  const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
  await writeFile(archivePath, archiveBuffer);

  const unpackDir = join(targetDir, `extract-${Date.now()}`);
  await mkdir(unpackDir, { recursive: true });

  const command = process.platform === "win32" ? "powershell" : "tar";
  const args = process.platform === "win32"
    ? [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${unpackDir}' -Force`,
      ]
    : ["-xzf", archivePath, "-C", unpackDir];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`extract failed with code ${code}`))));
  });

  const candidates: string[] = [
    join(unpackDir, "revenant"),
    join(targetDir, "revenant"),
  ];

  const found = await (async () => {
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate;
    }

    try {
      const entries = await readdir(unpackDir, { recursive: true });
      const nested = entries.filter((entry) => typeof entry === "string" && entry.endsWith("/revenant"));
      for (const entry of nested) {
        const full = join(unpackDir, entry);
        if (await fileExists(full)) return full;
      }
    } catch {
      // Ignore unmatched extraction layout
    }

    return null;
  })();

  if (!found) {
    await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }

  const finalBin = join(targetDir, "revenant");
  await copyFile(found, finalBin);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("chmod", ["+x", finalBin], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`chmod failed with code ${code}`))));
  });

  process.env.REVENANT_CLI_PATH = finalBin;
  await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
  return finalBin;
}

/** Resolve revenant binary: latest GitHub release by default, with explicit local opt-in only. */
export async function resolveRevenantCli(): Promise<string | null> {
  const localFallbackAllowed = isLocalCliOverrideAllowed();
  const fromEnv = process.env.REVENANT_CLI_PATH?.trim();

  if (!localFallbackAllowed && fromEnv) {
    delete process.env.REVENANT_CLI_PATH;
    console.warn(
      "[revenant-resolver] ignoring REVENANT_CLI_PATH because local fallback is disabled; using latest GitHub release only"
    );
  }

  if (fromEnv && localFallbackAllowed && (await fileExists(fromEnv))) {
    console.log(`[revenant-resolver] using REVENANT_CLI_PATH=${fromEnv}`);
    return fromEnv;
  }

  try {
    const installed = await installLatestRevenantCli();
    if (installed) {
      console.log(`[revenant-resolver] using GitHub release binary=${installed}`);
      return installed;
    }
  } catch (error) {
    console.warn("[revenant-resolver] GitHub release lookup failed:", error);
  }

  console.warn("[revenant-resolver] no release binary found; refusing local repo and PATH fallback");
  return null;
}

export function isAwsRecoveryMode(claimed: ClaimedPayload): boolean {
  return (
    claimed.database.recoveryMode === "aws-rds" ||
    claimed.recovery?.engine === "aws-rds"
  );
}

export function buildDatabaseUrl(claimed: ClaimedPayload): string | null {
  const { engine, host, port, databaseName, username, sslMode } = claimed.database;
  if (!host || !databaseName || !username || !claimed.password) {
    return null;
  }
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(claimed.password);
  const dbName = encodeURIComponent(databaseName);
  const p = port ?? (engine === "mysql" ? 3306 : 5432);
  if (engine === "mysql") {
    const tls = mysqlTlsQuery(sslMode);
    return `mysql://${user}:${pass}@${host}:${p}/${dbName}${tls}`;
  }
  const mode =
    !sslMode || sslMode === ""
      ? host === "localhost" || host === "127.0.0.1"
        ? "disable"
        : "require"
      : sslMode;
  const ssl = mode === "disable" ? "" : `?sslmode=${encodeURIComponent(mode)}`;
  return `postgresql://${user}:${pass}@${host}:${p}/${dbName}${ssl}`;
}

function mysqlTlsQuery(sslMode?: string | null): string {
  if (sslMode === "disable") return "";
  return `?tls=${sslMode === "prefer" ? "preferred" : "skip-verify"}`;
}

function extractChecksBlock(planYaml: string | null): string {
  const checksMatch = planYaml?.match(/checks:\s*\n[\s\S]*/i);
  let checksBlock = checksMatch?.[0]?.trimEnd() ?? "";

  if (!checksBlock) {
    checksBlock = "checks:\n  - type: connect";
  } else {
    checksBlock = checksBlock.replace(
      /(^\s*- type:\s*schema\s*\n)(\s*)tables:/gm,
      "$1$2expect_tables:"
    );
  }
  return stripHttpHealthFromChecksBlock(checksBlock);
}

export function buildDirectCliConfigYaml(
  planYaml: string | null,
  planName: string,
  engine: "postgres" | "mysql"
): string {
  return [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    `  engine: ${engine}`,
    "  connection: ${DATABASE_URL}",
    "",
    extractChecksBlock(planYaml),
    "",
  ].join("\n");
}

export function buildAwsCliConfigYaml(
  planYaml: string | null,
  planName: string,
  recovery: AwsRecoveryConfig,
  engine: "postgres" | "mysql",
  sslMode?: string | null
): string {
  const port = engine === "mysql" ? 3306 : 5432;
  const sandboxConnection = engine === "mysql"
    ? `mysql://\${SANDBOX_USER}:\${SANDBOX_PASSWORD}@\${SANDBOX_ENDPOINT}:${port}/\${SANDBOX_DBNAME}${mysqlTlsQuery(sslMode)}`
    : `postgres://\${SANDBOX_USER}:\${SANDBOX_PASSWORD}@\${SANDBOX_ENDPOINT}:${port}/\${SANDBOX_DBNAME}?sslmode=require`;
  const lines = [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    `  engine: ${engine}`,
    `  connection: ${sandboxConnection}`,
    "",
    "recovery:",
    "  engine: aws-rds",
    `  source_identifier: ${JSON.stringify(recovery.sourceIdentifier)}`,
    "  source_connection: ${SOURCE_DATABASE_URL}",
    `  region: ${JSON.stringify(recovery.region)}`,
  ];

  if (recovery.useFreetier) {
    lines.push("  use_freetier: true");
  }
  if (recovery.sandboxInstanceClass) {
    lines.push(
      `  sandbox_instance_class: ${JSON.stringify(recovery.sandboxInstanceClass)}`
    );
  }

  lines.push("", extractChecksBlock(planYaml), "");
  return lines.join("\n");
}

function runCommand(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    label: string;
    onProgress?: ReportRunnerProgress;
  }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutLine = "";
    let progressQueue = Promise.resolve();
    const progressChecks: Array<{
      checkName: string;
      checkType: string;
      status: "pass" | "fail";
      message: string;
    }> = [];
    let stage: RunnerProgressStage = opts.label.includes("snapshot")
      ? "checking_source"
      : "running_checks";
    const onLine = (line: string) => {
      const normalized = line.toLowerCase();
      let nextStage = stage;
      if (normalized.includes("creating") && normalized.includes("snapshot")) {
        nextStage = "creating_snapshot";
      } else if (normalized.includes("snapshot status")) {
        nextStage = "waiting_for_snapshot";
      } else if (normalized.includes("finding") && normalized.includes("snapshot")) {
        nextStage = "selecting_snapshot";
      } else if (normalized.includes("restoring") && normalized.includes("sandbox")) {
        nextStage = "restoring_sandbox";
      } else if (normalized.includes("waiting") && normalized.includes("sandbox")) {
        nextStage = "waiting_for_sandbox";
      } else if (normalized.includes("connecting") && normalized.includes("sandbox")) {
        nextStage = "connecting_sandbox";
      } else if (normalized.includes("destroying temporary")) {
        nextStage = "cleaning_sandbox";
      }
      const stageChanged = nextStage !== stage;
      stage = nextStage;
      const match = opts.label.includes("snapshot")
        ? line.trim().match(/^([✓✗])\s+(.+)$/)
        : null;
      if (match) {
        const [, marker, message] = match;
        progressChecks.push({
          checkName: message,
          checkType: "source_validation",
          status: marker === "✓" ? "pass" : "fail",
          message,
        });
      }
      if (opts.onProgress && (match || stageChanged)) {
        const progressMessage = match
          ? `${opts.label.includes("snapshot") ? "Source" : "Restore"} check ${match[1] === "✓" ? "passed" : "failed"}: ${match[2]}`
          : `CLI ${opts.label} is now ${stage.replaceAll("_", " ")}.`;
        progressQueue = progressQueue
          .then(() =>
            opts.onProgress?.(
              stage,
              progressMessage.slice(0, 255),
              progressChecks.slice(-100)
            )
          )
          .then(() => undefined)
          .catch((error: unknown) => {
            console.error("Runner progress reporting failed:", error);
          });
      }
    };
    child.stdout?.on("data", (d) => {
      const chunk = String(d);
      stdout += chunk;
      const lines = (stdoutLine + chunk).split(/\r\n|\n|\r/);
      stdoutLine = lines.pop() ?? "";
      for (const line of lines) if (line) onLine(line);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutLine) onLine(stdoutLine);
      void progressQueue.then(() => resolvePromise({ code, stdout, stderr }));
    });
  });
}

function mapCliReport(report: CliReport, checkType?: string): CheckResult[] {
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
      checkType: checkType ?? name.split(":")[0] ?? "check",
      status: st === "PASS" ? ("pass" as const) : ("fail" as const),
      message: c.message ?? st,
      durationMs: 0,
    };
  });
}

export function mapCliRecoverySnapshotResult(
  recovery: CliReport["recovery"]
): CheckResult | null {
  if (!recovery?.snapshot_identifier) return null;
  const snapshotArn = recovery.snapshot_arn
    ? `;snapshot_arn=${recovery.snapshot_arn}`
    : "";
  return {
    checkName: "recovery_snapshot",
    checkType: "recovery_snapshot",
    status: "pass",
    message: `snapshot_identifier=${recovery.snapshot_identifier}${snapshotArn}`,
    durationMs: 0,
  };
}

export function buildCliEnv(
  claimed: ClaimedPayload,
  awsMode: boolean
): { env: NodeJS.ProcessEnv; error?: string } {
  if (awsMode) {
    const { host, username, databaseName } = claimed.database;
    const recovery = claimed.recovery;
    const aws = claimed.awsCredentials;

    if (!recovery?.sourceIdentifier || !recovery.region) {
      return {
        env: process.env,
        error: "AWS recovery config incomplete — set RDS instance ID and region",
      };
    }
    if (!aws?.accessKeyId || !aws.secretAccessKey) {
      return {
        env: process.env,
        error: "AWS credentials missing — add access keys on the database",
      };
    }
    if (!host || !username || !claimed.password || !databaseName) {
      return {
        env: process.env,
        error:
          "Source RDS host, master username, password, and database name are required",
      };
    }
    const databaseUrl = buildDatabaseUrl(claimed);
    if (!databaseUrl) {
      return {
        env: process.env,
        error: "Could not build a source database URL for the selected database engine",
      };
    }

    return {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: aws.accessKeyId,
        AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
        ...(aws.sessionToken ? { AWS_SESSION_TOKEN: aws.sessionToken } : {}),
        AWS_REGION: recovery.region,
        SANDBOX_USER: username,
        SANDBOX_PASSWORD: claimed.password,
        SANDBOX_DBNAME: databaseName,
        DATABASE_URL: databaseUrl,
        SOURCE_DATABASE_URL: databaseUrl,
      },
    };
  }

  const databaseUrl = buildDatabaseUrl(claimed);
  if (!databaseUrl) {
    return {
      env: process.env,
      error: "Missing host, database name, username, or password",
    };
  }

  return {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  };
}

async function runWithCli(
  claimed: ClaimedPayload,
  cliPath: string,
  executionMode: "stub" | "agent" | "ci",
  reportProgress: ReportRunnerProgress
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const awsMode = isAwsRecoveryMode(claimed);
  const { env, error } = buildCliEnv(claimed, awsMode);

  if (error) {
    return {
      status: "fail",
      executionMode,
      usedCli: false,
      rtoSeconds: 1,
      errorMessage: error,
      results: [
        {
          checkName: "connect",
          checkType: "connect",
          status: "fail",
          message: error,
          durationMs: 0,
        },
      ],
    };
  }

  const planName = claimed.job.databaseName || "cloud-job";
  const httpSpecs = collectHttpHealthSpecs(
    claimed.planYaml,
    claimed.contractHealthcheck
  );
  const yaml = awsMode && claimed.recovery
    ? buildAwsCliConfigYaml(
        claimed.planYaml,
        planName,
        claimed.recovery,
        claimed.database.engine,
        claimed.database.sslMode
      )
    : buildDirectCliConfigYaml(
        claimed.planYaml,
        planName,
        claimed.database.engine
      );

  const dir = await mkdtemp(join(tmpdir(), "revenant-job-"));
  try {
    const configPath = join(dir, "revenant.yaml");
    const reportPath = join(dir, "report.json");
    await writeFile(configPath, yaml, "utf8");

    const timeoutMs = awsMode ? AWS_VERIFY_TIMEOUT_MS : DIRECT_VERIFY_TIMEOUT_MS;
    const results: CheckResult[] = [];
    const fullDrill = Boolean(claimed.fullDrill && awsMode);

    if (fullDrill) {
      await reportProgress(
        "checking_source",
        "Checking live source database against the validation plan."
      );
      const snapStarted = Date.now();
      const snap = await runCommand(cliPath, ["snapshot", "-c", configPath], {
        cwd: dir,
        env,
        timeoutMs: AWS_VERIFY_TIMEOUT_MS,
        label: "snapshot",
        onProgress: reportProgress,
      });
      const snapOk = snap.code === 0;
      let snapshotReport: CliReport = {};
      try {
        snapshotReport = JSON.parse(await readFile(reportPath, "utf8")) as CliReport;
      } catch {
        snapshotReport = {};
      }
      if (snapshotReport.checks?.length) {
        results.push(...mapCliReport(snapshotReport, "source_validation"));
      }
      results.push({
        checkName: "snapshot",
        checkType: "snapshot",
        status: snapOk ? "pass" : "fail",
        message: snapOk
          ? (snap.stdout || "RDS snapshot created").slice(0, 400)
          : (snap.stderr || snap.stdout || "revenant snapshot failed").slice(0, 500),
        durationMs: Date.now() - snapStarted,
      });
      if (snapshotReport.recovery?.snapshot_identifier) {
        results.push({
          checkName: "drill_snapshot_cleanup",
          checkType: "cleanup",
          status:
            snapshotReport.recovery.cleanup_status === "RETAINED" ||
            snapshotReport.recovery.expires_at
              ? "skip"
              : "fail",
          message: snapshotReport.recovery.expires_at
            ? `Recovery snapshot ${snapshotReport.recovery.snapshot_identifier} scheduled for deletion after ${snapshotReport.recovery.expires_at}.`
            : `Recovery snapshot ${snapshotReport.recovery.snapshot_identifier} retained by policy.`,
          durationMs: 0,
        });
      }
      await reportProgress(
        snapOk ? "selecting_snapshot" : "checking_source",
        snapOk
          ? "Live source validation and recovery snapshot creation are complete; starting restore verification."
          : "Live source validation or recovery snapshot creation failed.",
        results.map((result) => ({
          checkName: result.checkName,
          checkType: result.checkType,
          status: result.status === "error" ? "fail" as const : result.status,
          message: result.message,
        }))
      );
      if (!snapOk) {
        return {
          status: "fail",
          executionMode,
          usedCli: true,
          rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
          errorMessage: results[0]?.message,
          results,
        };
      }
    }

    if (!fullDrill) {
      await reportProgress(
        awsMode ? "selecting_snapshot" : "checking_source",
        awsMode
          ? "Finding the recovery snapshot to verify."
          : "Running the configured validation checks."
      );
    }
    const { code, stdout, stderr } = await runCommand(
      cliPath,
      ["verify", "-c", configPath, "-o", reportPath, "--markdown", join(dir, "report.md")],
      {
        cwd: dir,
        env,
        timeoutMs,
        label: "verify",
        onProgress: reportProgress,
      }
    );

    let report: CliReport = {};
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as CliReport;
    } catch {
      report = {};
    }

    const verifyResults = report.checks?.length ? mapCliReport(report) : [];
    if (verifyResults.length === 0 && (stdout || stderr)) {
      verifyResults.push({
        checkName: "verify",
        checkType: "verify",
        status: code === 0 ? "pass" : "fail",
        message: (stderr || stdout).slice(0, 500),
        durationMs: Date.now() - started,
      });
    }
    results.push(...verifyResults);
    const recoverySnapshot = mapCliRecoverySnapshotResult(report.recovery);
    if (recoverySnapshot) results.push(recoverySnapshot);
    if (report.recovery?.temporary_instance_identifier) {
      const cleanupStatus = report.recovery.cleanup_status?.toUpperCase() ?? "NOT_CREATED";
      results.push({
        checkName: "temp_instance_cleanup",
        checkType: "cleanup",
        status: cleanupStatus === "CLEANED"
          ? "pass"
          : cleanupStatus === "CLEANUP_FAILED"
            ? "fail"
            : "skip",
        message: `Temporary RDS ${report.recovery.temporary_instance_identifier} cleanup ${cleanupStatus.toLowerCase()}${report.recovery.cleanup_error ? `: ${report.recovery.cleanup_error}` : ""}`,
        durationMs: 0,
      });
    }
    await reportProgress(
      fullDrill ? "cleaning_sandbox" : "running_checks",
      "Restore verification checks are complete.",
      results.slice(-100).map((result) => ({
        checkName: result.checkName,
        checkType: result.checkType,
        status: result.status === "error" ? "fail" as const : result.status,
        message: result.message,
      }))
    );

    if (httpSpecs.length > 0) {
      results.push(...(await runHttpHealthChecks(httpSpecs)));
    }

    const verifyFailed =
      code !== 0 ||
      report.status?.toUpperCase() === "FAIL" ||
      verifyResults.some((r) => r.status === "fail") ||
      results.some((r) => r.checkType === "http_health" && r.status === "fail");

    if (fullDrill) {
      const reapStarted = Date.now();
      await reportProgress(
        "reaping_sandboxes",
        "Checking for orphaned temporary restore resources."
      );
      const reap = await runCommand(
        cliPath,
        ["reap", "--max-age", "2h", "--region", claimed.recovery?.region ?? ""],
        { cwd: dir, env, timeoutMs: 180_000, label: "reap" }
      );
      results.push({
        checkName: "reap",
        checkType: "reap",
        status: reap.code === 0 ? "pass" : "skip",
        message:
          reap.code === 0
            ? (reap.stdout || "Orphan sandboxes cleaned").slice(0, 400)
            : (reap.stderr || reap.stdout || "reap skipped").slice(0, 400),
        durationMs: Date.now() - reapStarted,
      });
    }

    const failed = verifyFailed || results.some((r) => r.status === "fail");

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
  const awsMode = isAwsRecoveryMode(claimed);
  const hasTarget = awsMode
    ? Boolean(
        claimed.recovery?.sourceIdentifier &&
          claimed.awsCredentials &&
          claimed.password &&
          claimed.database.username
      )
    : Boolean(claimed.database.host && claimed.password);
  const hasPlan = Boolean(claimed.planYaml);
  const simulated = executionMode === "stub";

  const results: CheckResult[] = [
    {
      checkName: awsMode ? "aws-recovery" : "connect",
      checkType: awsMode ? "aws-rds" : "connect",
      status: hasTarget ? "pass" : "fail",
      message: `${simulated ? "[SIMULATED] " : ""}${
        hasTarget
          ? awsMode
            ? `AWS restore drill configured for ${claimed.recovery?.sourceIdentifier} (${reason})`
            : `Target ${claimed.database.host}:${claimed.database.port ?? 5432} received (${reason})`
          : awsMode
            ? "Missing AWS recovery config or credentials"
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

export async function executeClaimedJob(
  claimed: ClaimedPayload,
  executionMode: "stub" | "agent" | "ci",
  reportProgress?: ReportRunnerProgress
): Promise<ExecutionOutcome> {
  const forceSim =
    process.env.REVENANT_FORCE_SIMULATE === "true" ||
    (executionMode === "stub" && process.env.REVENANT_STUB_SIMULATE === "true");

  if (forceSim) {
    return runMetadataFallback(claimed, executionMode, "forced simulation");
  }

  const cli = await resolveRevenantCli();
  if (!cli) {
    return runMetadataFallback(
      claimed,
      executionMode,
      "revenant CLI not found — latest GitHub release could not be fetched, or local fallback is disabled"
    );
  }

  return runWithCli(
    claimed,
    cli,
    executionMode,
    reportProgress ?? (async () => undefined)
  );
}
