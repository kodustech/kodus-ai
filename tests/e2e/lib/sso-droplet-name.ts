// Shared by sso-cookie-domain.ts and sso-multi-user.ts, which must
// target the exact same AWS resource name to reuse/destroy the one
// droplet between them — duplicating this derivation invites drift.
//
// The name is a fixed AWS resource name (key pair + EC2 Name tag).
// Locally that's deliberate: `--reuse` lets a dev provision once and
// keep poking the same "sso-e2e" droplet across many matrix runs and
// manual `sso-e2e:droplet:*` invocations. In CI it is not safe to
// reuse a single fixed name across runs: a cancelled or failed run
// (concurrency: cancel-in-progress fires re-runs on fresh ephemeral
// runners with no local state) can leave its droplet alive after
// provisioning but before sso-multi-user's finally-block teardown, and
// the next run's `import-key-pair` then fails on that leftover with
// the exact same misleading symptom this module was added to fix
// (see PR #1919) — just CI-vs-CI instead of CI-vs-local. Keying the
// CI name off GITHUB_RUN_ID makes every run's droplet name unique, so
// a leftover from one run can never block a later one; the 6h reaper
// sweep remains the backstop for whatever a leftover run's own
// teardown misses.
//
// GITHUB_RUN_ID alone isn't enough: GitHub keeps it constant across a
// "Re-run failed jobs" of the same workflow run — only
// GITHUB_RUN_ATTEMPT increments. Without it, re-running a cancelled or
// failed run reuses the previous attempt's leaked name and hits the
// exact same collision on a fresh, stateless runner. Both scenarios
// still agree on the name because they run within the same attempt.
export function ssoDropletName(): string {
    if (process.env.CI !== "true") {
        return "sso-e2e";
    }
    const runId = process.env.GITHUB_RUN_ID ?? "local";
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
    return `sso-e2e-ci-${runId}-${attempt}`;
}
