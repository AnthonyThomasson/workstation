// How long the deep check may take, and how long `herdr-tasks device check` waits for it. Lives in lib/ (the lowest tier) so both
// devices/ and cli/ read it: the CLI's wait is derived from the deep timeout and can't drift below it.

// A desktop spawn costs 4-24s (95s seen), and the cap Herdr allows is 600s: generous, not unbounded.
export const DEEP_TIMEOUT_MS = 300000;
// The CLI waits the deep timeout plus this much (the probe, reading the binding, saving the result), so the check's own timeout
// always lands first and the person gets its answer rather than "still working".
export const DEEP_WAIT_MARGIN_S = 30;
export const DEEP_WAIT_S = Math.ceil(DEEP_TIMEOUT_MS / 1000) + DEEP_WAIT_MARGIN_S;

// Herdr caps every exec at 600s (`hc exec --timeout` at most 600; herdr.d.ts: "capped at 600,000"). Anything that must last longer
// than that is not one exec: a run goes in a detached Herdr terminal that is waited on in slices of at most this many seconds.
export const EXEC_CAP_MS = 600000;
export const EXEC_CAP_S = EXEC_CAP_MS / 1000;
// How long `device run`'s command may run: 1.5 hours. The cap is on the run's own clock, not on any one exec.
export const RUN_TIMEOUT_MS = 5400000;
// Each `hc wait` of a run's terminal asks for this many seconds and is its own exec: it, plus the grace below, stays under the cap.
export const WAIT_SLICE_S = 590;
export const WAIT_GRACE_MS = 10000;
// The CLI waits the run's cap plus this much (the send, the checkout, the read-back and the cleanup are a desktop spawn each at 4-95s,
// and the send may take the whole exec cap), so the run's own timeout always lands first and the person gets its answer.
export const RUN_WAIT_MARGIN_S = 600;
export const RUN_WAIT_S = RUN_TIMEOUT_MS / 1000 + RUN_WAIT_MARGIN_S;
