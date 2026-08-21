import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cleanup-authority-"));
const previousWalletKey = process.env.WALLET_PRIVATE_KEY;
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");
process.env.DRY_RUN = "true";
delete process.env.EMERGENCY_STOP;
delete process.env.WALLET_PRIVATE_KEY;
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({
  dryRun: true,
  rolloutMode: "dry_run",
  cleanupEnabled: true,
}));
fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify({ positions: {} }));

try {
  // config captures immutable rollout authority at import time.
  const { isEffectiveDryRun } = await import("../config.js");
  assert.equal(isEffectiveDryRun(), true);
  process.env.DRY_RUN = "false";

  const {
    CLEANUP_EXECUTION_CONFIRMATION,
    executeConfirmedCleanup,
    registerOperatorCleanupCapability,
  } = await import("../tools/executor.js");
  const operatorCapability = Object.freeze({});
  registerOperatorCleanupCapability(operatorCapability);

  let dependencyCalls = 0;
  const result = await executeConfirmedCleanup({
    position: "cleanup-authority-test-position",
    confirmation: CLEANUP_EXECUTION_CONFIRMATION,
    operatorCapability,
    dependencies: {
      getWalletBalances: async () => {
        dependencyCalls += 1;
        throw new Error("dry-run cleanup must not read balances");
      },
      connection: {
        getParsedTokenAccountsByOwner: async () => {
          dependencyCalls += 1;
          throw new Error("dry-run cleanup must not call RPC");
        },
      },
    },
  });

  assert.equal(isEffectiveDryRun(), true, "mutable environment cannot change boot authority");
  assert.equal(result.blocked, "DRY_RUN_NO_CLEANUP_EXECUTION");
  assert.deepEqual(result.execution, { executed: false, dry_run: true });
  assert.equal(dependencyCalls, 0, "block before dependencies, signer loading, or RPC");
  console.log("cleanup authority tests passed");
} finally {
  if (previousWalletKey == null) delete process.env.WALLET_PRIVATE_KEY;
  else process.env.WALLET_PRIVATE_KEY = previousWalletKey;
  fs.rmSync(tmp, { recursive: true, force: true });
}
