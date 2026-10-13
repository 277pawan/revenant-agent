import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAwsCliConfigYaml,
  buildDirectCliConfigYaml,
  buildCliEnv,
  buildDatabaseUrl,
  buildGitHubReleaseHeaders,
  buildReleaseAssetName,
  mapCliRecoverySnapshotResult,
  mapCliReport,
  sanitizeCliOutput,
  executeClaimedJob,
} from "./execute-job.js";

const mysqlPayload = {
  job: { id: "job-mysql", databaseName: "Production Mysql" },
  database: {
    engine: "mysql" as const,
    host: "mysql.example",
    port: 3306,
    databaseName: "myapp",
    username: "admin",
    sslMode: "require",
    recoveryMode: "aws-rds" as const,
  },
  password: "mysql-secret",
  recovery: {
    engine: "aws-rds" as const,
    sourceIdentifier: "mysql-database-1",
    region: "eu-west-2",
    useFreetier: true,
    sandboxInstanceClass: "db.t3.micro",
  },
  awsCredentials: {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "aws-secret",
    sessionToken: "aws-session-token",
  },
  planYaml: "checks:\n  - type: connect",
  fullDrill: true,
};

const mongoUri =
  "mongodb+srv://validator:secret@cluster0.example.mongodb.net/app?retryWrites=true";
const mongoPayload = {
  job: { id: "job-mongo", databaseName: "Atlas production" },
  database: {
    id: "db-mongo",
    name: "Atlas production",
    engine: "mongodb" as const,
    host: null,
    port: null,
    databaseName: "app",
    username: null,
    sslMode: null,
    recoveryMode: "direct" as const,
  },
  password: null,
  connectionString: mongoUri,
  recovery: null,
  awsCredentials: null,
  planYaml: "checks:\n  - type: collections\n    name: collections exist",
  fullDrill: false,
};

test("MongoDB direct jobs create CLI-compatible YAML and pass URI only through MONGODB_URI", () => {
  const yaml = buildDirectCliConfigYaml(
    mongoPayload.planYaml,
    mongoPayload.job.databaseName,
    "mongodb",
    mongoPayload.database.databaseName
  );
  assert.match(yaml, /engine: mongodb/);
  assert.match(yaml, /connection: \$\{MONGODB_URI\}/);
  assert.match(yaml, /name: "app"/);
  assert.doesNotMatch(yaml, /validator:secret/);

  const configured = buildCliEnv(mongoPayload, false);
  assert.equal(configured.error, undefined);
  assert.equal(configured.env.MONGODB_URI, mongoUri);
  assert.equal(buildDatabaseUrl(mongoPayload), null);
});

test("MongoDB URI is redacted from CLI diagnostics", () => {
  const message = sanitizeCliOutput(`connection failed ${mongoUri}`, {
    MONGODB_URI: mongoUri,
  });
  assert.doesNotMatch(message, /validator:secret/);
  assert.match(message, /REDACTED_MONGODB_URI/);
});

test("failed MongoDB CLI checks remain failed in agent job results", () => {
  const results = mapCliReport({
    status: "FAIL",
    checks: [{ name: "connect", status: "FAIL", message: "authentication failed" }],
  });
  assert.equal(results[0]?.status, "fail");
  assert.equal(results[0]?.message, "authentication failed");
});

test("MongoDB missing credentials and restore requests fail rather than report simulated passes", async () => {
  const missing = await executeClaimedJob(
    { ...mongoPayload, connectionString: null },
    "agent"
  );
  assert.equal(missing.status, "fail");
  assert.equal(missing.results[0]?.status, "fail");
  assert.match(missing.errorMessage ?? "", /MongoDB URI/);

  const unsupported = await executeClaimedJob(
    {
      ...mongoPayload,
      database: { ...mongoPayload.database, recoveryMode: "aws-rds" },
    },
    "agent"
  );
  assert.equal(unsupported.status, "fail");
  assert.match(unsupported.errorMessage ?? "", /does not support AWS\/RDS/);
});

test("maps the verified AWS snapshot identifier and ARN into a recovery result", () => {
  const result = mapCliRecoverySnapshotResult({
    snapshot_identifier: "revenant-prod-20260927",
    snapshot_arn:
      "arn:aws:rds:us-east-1:123456789012:snapshot:revenant-prod-20260927",
  });

  assert.deepEqual(result, {
    checkName: "recovery_snapshot",
    checkType: "recovery_snapshot",
    status: "pass",
    message:
      "snapshot_identifier=revenant-prod-20260927;snapshot_arn=arn:aws:rds:us-east-1:123456789012:snapshot:revenant-prod-20260927",
    durationMs: 0,
  });
});

test("does not register a recovery snapshot when the CLI report has no identifier", () => {
  assert.equal(mapCliRecoverySnapshotResult({ cleanup_status: "deleted" }), null);
});

test("builds a MySQL source URL from the selected database instead of PostgreSQL", () => {
  assert.equal(
    buildDatabaseUrl(mysqlPayload),
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=skip-verify"
  );
  assert.equal(
    buildDatabaseUrl({
      ...mysqlPayload,
      database: { ...mysqlPayload.database, sslMode: "prefer" },
    }),
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=preferred"
  );
  assert.equal(
    buildDatabaseUrl({
      ...mysqlPayload,
      database: { ...mysqlPayload.database, sslMode: "disable" },
    }),
    "mysql://admin:mysql-secret@mysql.example:3306/myapp"
  );
});

test("builds AWS verification YAML using the selected MySQL engine", () => {
  const yaml = buildAwsCliConfigYaml(
    mysqlPayload.planYaml,
    mysqlPayload.job.databaseName,
    mysqlPayload.recovery,
    mysqlPayload.database.engine,
    mysqlPayload.database.sslMode
  );
  assert.match(yaml, /engine: mysql/);
  assert.match(
    yaml,
    /connection: mysql:\/\/\$\{SANDBOX_USER\}:\$\{SANDBOX_PASSWORD\}@\$\{SANDBOX_ENDPOINT\}:3306\/\$\{SANDBOX_DBNAME\}\?tls=skip-verify/
  );
  assert.match(yaml, /source_connection: \$\{SOURCE_DATABASE_URL\}/);
  assert.doesNotMatch(yaml, /postgres/);
});

test("AWS snapshot environment sets the selected MySQL source URL and session token", () => {
  const result = buildCliEnv(mysqlPayload, true);
  assert.equal(result.error, undefined);
  assert.equal(
    result.env.SOURCE_DATABASE_URL,
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=skip-verify"
  );
  assert.equal(
    result.env.DATABASE_URL,
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=skip-verify"
  );
  assert.equal(result.env.AWS_SESSION_TOKEN, "aws-session-token");
});

test("AWS snapshot requires its configured source instead of inheriting DATABASE_URL", () => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://local-user@localhost:5432/";
  try {
    const result = buildCliEnv(
      {
        ...mysqlPayload,
        database: { ...mysqlPayload.database, host: null },
      },
      true
    );
    assert.match(result.error ?? "", /Source RDS host/);
    assert.equal(result.env.DATABASE_URL, "postgres://local-user@localhost:5432/");
    assert.equal(result.env.SOURCE_DATABASE_URL, undefined);
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});

test("buildReleaseAssetName creates the expected GitHub release asset name", () => {
  const asset = buildReleaseAssetName("v0.1.1");
  assert.ok(asset);
  assert.match(asset!, /^revenant_0\.1\.1_/);
  assert.ok(asset!.endsWith(".tar.gz") || asset!.endsWith(".zip"));
});

test("GitHub release download auth stays separate from CLI job environment", () => {
  assert.deepEqual(
    buildGitHubReleaseHeaders("application/vnd.github+json", " release-token "),
    {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer release-token",
    }
  );
  const previousToken = process.env.REVENANT_CLI_GITHUB_TOKEN;
  process.env.REVENANT_CLI_GITHUB_TOKEN = "release-token";
  try {
    assert.equal(buildCliEnv(mongoPayload, false).env.REVENANT_CLI_GITHUB_TOKEN, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.REVENANT_CLI_GITHUB_TOKEN;
    else process.env.REVENANT_CLI_GITHUB_TOKEN = previousToken;
  }
});
