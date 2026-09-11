/**
 * Shared poll loop — Agent Box, embedded API worker, stub script.
 */
import {
  executeClaimedJob,
  type ClaimedPayload,
  type ExecutionOutcome,
} from "./execute-job.js";

export type RunnerPollOptions = {
  apiBase: string;
  token: string;
  executionMode: "stub" | "agent" | "ci";
  intervalMs?: number;
  label?: string;
};

async function claimAndComplete(opts: RunnerPollOptions): Promise<void> {
  const claimRes = await fetch(`${opts.apiBase}/api/v1/runner/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (claimRes.status === 204) return;

  if (!claimRes.ok) {
    console.error(
      `[${opts.label ?? opts.executionMode}] claim failed:`,
      claimRes.status,
      await claimRes.text()
    );
    return;
  }

  const claimed = (await claimRes.json()) as ClaimedPayload & {
    executionMode?: string;
  };

  console.log(
    `[${opts.label ?? opts.executionMode}] claimed ${claimed.job.id} (${claimed.job.databaseName})`
  );

  const outcome: ExecutionOutcome = await executeClaimedJob(
    claimed,
    opts.executionMode
  );

  const completeRes = await fetch(
    `${opts.apiBase}/api/v1/runner/jobs/${claimed.job.id}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: outcome.status,
        executionMode: outcome.usedCli
          ? opts.executionMode === "stub"
            ? "agent"
            : opts.executionMode
          : outcome.executionMode,
        rtoSeconds: outcome.rtoSeconds,
        errorMessage: outcome.errorMessage,
        results: outcome.results,
      }),
    }
  );

  if (!completeRes.ok) {
    console.error(
      `[${opts.label ?? opts.executionMode}] complete failed:`,
      completeRes.status,
      await completeRes.text()
    );
    return;
  }

  console.log(
    `[${opts.label ?? opts.executionMode}] completed ${claimed.job.id} → ${outcome.status}` +
      (outcome.usedCli ? " (revenant verify)" : " (fallback)")
  );
}

export function startRunnerPoll(opts: RunnerPollOptions): () => void {
  const intervalMs = opts.intervalMs ?? 3000;
  const label = opts.label ?? opts.executionMode;
  console.log(`[${label}] polling ${opts.apiBase} every ${intervalMs}ms`);

  const tick = () => {
    void claimAndComplete(opts).catch((err) =>
      console.error(`[${label}]`, err)
    );
  };

  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}
