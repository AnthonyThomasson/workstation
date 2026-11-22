// Public interface of devices/: the only file code outside this folder may import.
export { DEEP_TIMEOUT_MS, runDeepCheck } from "./deep-check.js";
export { DEEP_SCRIPT, LEVELS, MIN_FREE_KB, STALE_AFTER_MS, bindMachine, cheapHealth, deepArgs, deepChecks, failing, healthOf, isRepoKey, machinesFrom, normalizeBinding, normalizeHealth, parseDeep, pickRepoFolder, probeFailure, repoRootFor, repoSlug, requiresFromConfig, rollup, startsHere, withHealth, withRepoRoot, withStartHere } from "./test-device.js";
