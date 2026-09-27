export type HttpHealthSpec = {
  url: string;
  name: string;
  expectStatus: number;
};

export type HttpHealthCheckResult = {
  checkName: string;
  checkType: "http_health";
  status: "pass" | "fail";
  message: string;
  durationMs: number;
};

/** Remove http_health entries — executed in Node, not the Go CLI (older CLIs lack the type). */
export function stripHttpHealthFromChecksBlock(checksBlock: string): string {
  const stripped = checksBlock.replace(
    /\n\s*-\s*type:\s*http_health\b[^\n]*(?:\n\s+[^\n-][^\n]*)*/gi,
    ""
  );
  return stripped.trimEnd() || "checks:\n  - type: connect";
}

function parseHttpHealthSpecsFromPlan(planYaml: string | null): HttpHealthSpec[] {
  if (!planYaml) return [];
  const checksMatch = planYaml.match(/checks:\s*\n([\s\S]*)/i);
  if (!checksMatch) return [];

  const specs: HttpHealthSpec[] = [];
  const itemRe = /-\s*type:\s*http_health\b([\s\S]*?)(?=\n\s*-\s*type:|\s*$)/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(checksMatch[0])) !== null) {
    const block = match[1];
    const urlMatch =
      block.match(/url:\s*["']([^"']+)["']/i) ?? block.match(/url:\s*(\S+)/i);
    if (!urlMatch?.[1]) continue;
    const nameMatch = block.match(/name:\s*["']?([^"'\n]+)["']?/i);
    const statusMatch = block.match(/expect_status:\s*(\d+)/i);
    specs.push({
      url: urlMatch[1].trim(),
      name: nameMatch?.[1]?.trim() || "application_health",
      expectStatus: statusMatch ? Number(statusMatch[1]) : 200,
    });
  }
  return specs;
}

export function collectHttpHealthSpecs(
  planYaml: string | null,
  contractHealthcheck?: { url: string } | null
): HttpHealthSpec[] {
  const specs = parseHttpHealthSpecsFromPlan(planYaml);
  const contractUrl = contractHealthcheck?.url?.trim();
  if (contractUrl && !specs.some((s) => s.url === contractUrl)) {
    specs.push({
      url: contractUrl,
      name: "application_health",
      expectStatus: 200,
    });
  }
  return specs;
}

export async function runHttpHealthCheck(
  spec: HttpHealthSpec
): Promise<HttpHealthCheckResult> {
  const started = Date.now();
  try {
    const res = await fetch(spec.url, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    const ok = res.status === spec.expectStatus;
    return {
      checkName: spec.name,
      checkType: "http_health",
      status: ok ? "pass" : "fail",
      message: ok
        ? `HTTP GET ${spec.url} returned ${res.status}`
        : `expected HTTP ${spec.expectStatus}, got ${res.status} from ${spec.url}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      checkName: spec.name,
      checkType: "http_health",
      status: "fail",
      message: `HTTP health check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      durationMs: Date.now() - started,
    };
  }
}

export async function runHttpHealthChecks(
  specs: HttpHealthSpec[]
): Promise<HttpHealthCheckResult[]> {
  const results: HttpHealthCheckResult[] = [];
  for (const spec of specs) {
    results.push(await runHttpHealthCheck(spec));
  }
  return results;
}
