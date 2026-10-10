import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAwsCliConfigYaml,
  buildCliEnv,
  buildDatabaseUrl,
  buildReleaseAssetName,
  mapCliRecoverySnapshotResult,
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
