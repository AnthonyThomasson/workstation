// How long the deep check may take, and how long `herdr-tasks device check` waits for it. Lives in lib/ (the lowest tier) so both
// devices/ and cli/ read it: the CLI's wait is derived from the deep timeout and can't drift below it.

// A desktop spawn costs 4-24s (95s seen), and the cap Herdr allows is 600s: generous, not unbounded.
export const DEEP_TIMEOUT_MS = 300000;
// The CLI waits the deep timeout plus this much (the probe, reading the binding, saving the result), so the check's own timeout
// always lands first and the person gets its answer rather than "still working".
export const DEEP_WAIT_MARGIN_S = 30;
export const DEEP_WAIT_S = Math.ceil(DEEP_TIMEOUT_MS / 1000) + DEEP_WAIT_MARGIN_S;
