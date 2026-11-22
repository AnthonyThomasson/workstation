// Public interface of devices/: the only file code outside this folder may import.
export { DEEP_TIMEOUT_MS, runDeepCheck } from "./deep-check.js";
export { DEEP_SCRIPT, LEVELS, MIN_FREE_KB, STALE_AFTER_MS, bindMachine, cheapHealth, deepArgs, deepChecks, failing, healthOf, isRepoKey, machinesFrom, normalizeBinding, normalizeHealth, parseDeep, pickRepoFolder, probeFailure, repoRootFor, repoSlug, requiresFromConfig, rollup, startsHere, withHealth, withRepoRoot, withStartHere } from "./test-device.js";
export { CLEANUP, EXIT, LOG_TAIL_BYTES, PREPARE, RUN_TIMEOUT_MS, STALE_LOCK_S, STEP_TIMEOUT_MS, SWEEP_AFTER_MIN, TIMED_OUT_CODE, exitFor, newTestRunId, parseKeyValues, parseReadBack, readiness, runOnDevice, sinceText, testRunRef } from "./test-run.js";
export { cheapFor, checkView, deviceView, problemLines, runView } from "./device-cli.js";
