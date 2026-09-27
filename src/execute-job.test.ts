import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseAssetName,
  mapCliRecoverySnapshotResult,
} from "./execute-job.js";

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

test("buildReleaseAssetName creates the expected GitHub release asset name", () => {
  const asset = buildReleaseAssetName("v0.1.1");
  assert.ok(asset);
  assert.match(asset!, /^revenant_0\.1\.1_/);
  assert.ok(asset!.endsWith(".tar.gz") || asset!.endsWith(".zip"));
});
