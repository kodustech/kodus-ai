import type { RuntimeRun } from "../../contracts";
import { reduceRunStream } from "../../stream";

// Two Runs of an invented repository for the Run screen's specs: one partly
// tested (a matching path, a path no probe reached, exploration that failed,
// a comment still being retried) and one with a regression.

const T0 = Date.UTC(2026, 10, 6, 18, 6, 0);
export const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const SHA_BASE = "ee53311".padEnd(40, "0");
const SHA_HEAD = "5d49b8a".padEnd(40, "0");

const baseRun: RuntimeRun = {
    runId: "run-1",
    attempt: 1,
    teamId: "team-1",
    repositoryId: "repo-1",
    repositoryName: "acme/shop",
    prNumber: 3,
    headSha: SHA_HEAD,
    baseSha: SHA_BASE,
    baseBranch: "main",
    environmentId: "env-1",
    state: "partly_tested",
    verdictState: "partly_tested",
    requestedAt: at(0),
    bootingAt: at(20),
    finishedAt: at(591),
    updatedAt: at(591),
    cellOwner: "kodus",
    check: { conclusion: "neutral", title: "Partly tested" },
    phaseMs: { boot: 14_000, apply: 471_000 },
    buildSteps: [
        {
            side: "pr",
            steps: 12,
            done: 12,
            cached: 9,
            errored: 0,
            slowest: [
                { service: "app", name: "RUN make build-go", ms: 400_000 },
                { service: "app", name: "load build context", ms: 44_100 },
            ],
        },
    ],
    probes: [
        {
            probeId: "health",
            entryPoint: "GET /api/health",
            verdict: "not_reproduced",
            reason: "same on base and PR",
            baseStepIds: ["b1", "b2"],
            prStepIds: ["p1"],
        },
    ],
    uncoveredEntryPoints: ["pkg/main.go"],
    exploration: [
        {
            index: 0,
            stepId: "e1",
            command: "cd /app/workspace && ls",
            exitCode: 127,
            durationMs: 325,
            failed: true,
        },
        {
            index: 1,
            stepId: "e2",
            command: "cat go.mod",
            error: "exec_timeout",
            failed: true,
        },
    ],
    publication: {
        postsToPullRequest: true,
        check: { status: "published", at: at(576) },
        comment: {
            status: "pending",
            retrying: true,
            redriveAttempts: 1,
        },
        settled: false,
    },
    cost: {
        estimate: true,
        currency: "USD",
        llmTokens: 2850,
        machines: {
            minutes: 9,
            vm: { instanceType: "m7i.2xlarge", count: 2, usdPerHour: 0.4 },
            observer: { instanceType: "t3.medium", count: 2, usdPerHour: 0.04 },
            region: "us-east-1",
            usd: 0.13,
            paidBy: "kodus",
        },
        llm: {
            tokens: 2850,
            usd: 0.005,
            models: [],
            unsettledTokens: 0,
        },
        totalUsd: 0.14,
        complete: true,
    },
};

export const partlyTestedRun = (
    patch: Partial<RuntimeRun> = {},
): RuntimeRun => ({
    ...baseRun,
    ...patch,
});

export const partlyTestedView = () =>
    reduceRunStream([
        { type: "state", at: at(0), data: { state: "queued" } },
        { type: "state", at: at(20), data: { state: "booting" } },
        { type: "state", at: at(505), data: { state: "testing" } },
        {
            type: "phase",
            at: at(506),
            data: { phase: "agent", entryPoints: ["a", "b"] },
        },
        {
            type: "step.started",
            at: at(507),
            data: { stepId: "e1", side: "base", kind: "exec" },
        },
        {
            type: "step.finished",
            at: at(508),
            data: {
                stepId: "e1",
                outcome: "ok",
                exitCode: 127,
                durationMs: 325,
            },
        },
        {
            type: "phase",
            at: at(510),
            data: { phase: "replay", probes: 1, explored: 2, exploreFailed: 2 },
        },
        {
            type: "step.started",
            at: at(520),
            data: { stepId: "r1", side: "base", kind: "machine.reset" },
        },
        {
            type: "step.finished",
            at: at(534),
            data: { stepId: "r1", outcome: "ok", durationMs: 13_800 },
        },
        {
            type: "step.started",
            at: at(537),
            data: {
                stepId: "b1",
                side: "base",
                kind: "probe.run",
                probeId: "health",
            },
        },
        {
            type: "step.finished",
            at: at(538),
            data: { stepId: "b1", outcome: "ok", status: 200, durationMs: 319 },
        },
        {
            type: "step.started",
            at: at(540),
            data: {
                stepId: "b2",
                side: "base",
                kind: "probe.run",
                probeId: "health",
            },
        },
        {
            type: "step.finished",
            at: at(541),
            data: { stepId: "b2", outcome: "ok", status: 200, durationMs: 301 },
        },
        {
            type: "step.started",
            at: at(547),
            data: {
                stepId: "p1",
                side: "pr",
                kind: "probe.run",
                probeId: "health",
            },
        },
        {
            type: "step.finished",
            at: at(548),
            data: { stepId: "p1", outcome: "ok", status: 200, durationMs: 316 },
        },
        {
            type: "verdict",
            at: at(573),
            data: {
                verdictState: "partly_tested",
                findings: 0,
                uncovered: ["pkg/main.go"],
                forcedNeutral: [],
            },
        },
        { type: "state", at: at(574), data: { state: "partly_tested" } },
        {
            type: "published",
            at: at(576),
            data: { conclusion: "neutral", title: "Partly tested" },
        },
    ]);

export const regressionRun = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
    ...baseRun,
    runId: "run-2",
    state: "regression",
    verdictState: "regression",
    check: { conclusion: "failure", title: "1 regression" },
    reproducible: ["orders-coupon"],
    feedback: { "orders-coupon": { up: 1, down: 0 } },
    exploration: undefined,
    probes: [
        {
            probeId: "orders-coupon",
            entryPoint: "POST /orders",
            verdict: "finding",
            intent: "unintended",
            reason: "status differs",
            differingFields: ["status", "json.error"],
            baseStepIds: ["rb1", "rb2"],
            prStepIds: ["rp1", "rp2"],
        },
        {
            probeId: "cart",
            entryPoint: "GET /cart",
            verdict: "not_reproduced",
            reason: "same",
            baseStepIds: ["cb1"],
            prStepIds: ["cp1"],
        },
        {
            probeId: "order-detail",
            entryPoint: "GET /orders/:id",
            verdict: "finding",
            intent: "intended",
            reason: "a field differs",
            differingFields: ["json.total_before_tax"],
            baseStepIds: ["ob1"],
            prStepIds: ["op1"],
        },
    ],
    uncoveredEntryPoints: ["POST /payments"],
    uncovered: [
        {
            entryPoint: "POST /payments",
            reason: "blocker",
            blocker: { kind: "missing_env", name: "STRIPE_TEST_KEY" },
        },
    ],
    ...patch,
});

const probeStep = (
    stepId: string,
    side: "base" | "pr",
    status: number,
    s: number,
    ms: number,
) => [
    {
        type: "step.started" as const,
        at: at(s),
        data: { stepId, side, kind: "probe.run" },
    },
    {
        type: "step.finished" as const,
        at: at(s + 1),
        data: { stepId, outcome: "ok", status, durationMs: ms },
    },
];

export const regressionView = () =>
    reduceRunStream([
        { type: "state", at: at(0), data: { state: "queued" } },
        { type: "state", at: at(20), data: { state: "booting" } },
        { type: "state", at: at(505), data: { state: "testing" } },
        ...probeStep("rb1", "base", 201, 520, 88),
        ...probeStep("rb2", "base", 201, 525, 90),
        ...probeStep("rp1", "pr", 500, 530, 41),
        ...probeStep("rp2", "pr", 500, 535, 43),
        ...probeStep("cb1", "base", 200, 540, 20),
        ...probeStep("cp1", "pr", 200, 545, 21),
        ...probeStep("ob1", "base", 200, 550, 30),
        ...probeStep("op1", "pr", 200, 555, 31),
        {
            type: "verdict",
            at: at(573),
            data: { verdictState: "regression", findings: 1, intended: 1 },
        },
        { type: "state", at: at(574), data: { state: "regression" } },
    ]);

// demo-grafana, the Runs the evidence work was measured on: PR #4's
// `/api/health` that answers 503 with database "failing" where main answers
// 200 with "ok", and PR #6's image build that could not reach
// sum.golang.org from the sandbox.

export const HEALTH_ERROR_LOG = "database is locked";

export const healthLanes = (): NonNullable<
    NonNullable<RuntimeRun["probes"]>[number]["lanes"]
> => {
    const captured = { requests: false, logs: true, db: false, outbound: true };
    const base = {
        side: "base" as const,
        round: 1,
        stepId: "hb1",
        t0: at(520),
        windowMs: 40,
        events: [
            {
                kind: "log" as const,
                at: 9,
                service: "grafana",
                label: 'logger=context msg="Request Completed" method=GET path=/api/health status=200',
            },
            { kind: "response" as const, at: 11, label: "status 200" },
        ],
        captured,
        artifacts: [{ type: "logs" as const, bytes: 2_150, truncated: false }],
        truncated: false,
    };
    const pr = {
        side: "pr" as const,
        round: 1,
        stepId: "hp1",
        t0: at(530),
        windowMs: 48,
        events: [
            {
                kind: "log" as const,
                at: 12,
                service: "grafana",
                label: HEALTH_ERROR_LOG,
            },
            {
                kind: "log" as const,
                at: 14,
                service: "grafana",
                label: 'logger=context msg="Request Completed" method=GET path=/api/health status=503',
            },
            {
                kind: "outbound" as const,
                at: 20,
                label: "grafana.com:443 blocked",
            },
            { kind: "response" as const, at: 16, label: "status 503" },
        ],
        captured,
        artifacts: [{ type: "logs" as const, bytes: 3_420, truncated: false }],
        truncated: false,
    };
    return {
        base,
        pr,
        firstDifference: {
            index: 0,
            kind: "log",
            base: base.events[0],
            pr: pr.events[0],
        },
    };
};

export const healthRegressionRun = (
    patch: Partial<RuntimeRun> = {},
): RuntimeRun => ({
    ...baseRun,
    runId: "run-health",
    repositoryName: "kodus/demo-grafana",
    prNumber: 4,
    state: "regression",
    verdictState: "regression",
    check: { conclusion: "failure", title: "1 regression" },
    exploration: undefined,
    reproducible: ["health"],
    probes: [
        {
            probeId: "health",
            entryPoint: "GET /api/health",
            verdict: "finding",
            intent: "unintended",
            reason: "status differs",
            differingFields: ["status", "json.database"],
            baseStepIds: ["hb1", "hb2"],
            prStepIds: ["hp1", "hp2"],
            responseDiff: {
                fields: [
                    { path: "json.database", base: '"ok"', pr: '"failing"' },
                    { path: "json.commit", base: '"ee53311"' },
                ],
                truncated: false,
            },
            diffRef: { file: "pkg/api/health.go", line: 23 },
            lanes: healthLanes(),
        },
    ],
    uncoveredEntryPoints: [],
    ...patch,
});

export const healthRegressionView = () =>
    reduceRunStream([
        { type: "state", at: at(0), data: { state: "queued" } },
        { type: "state", at: at(20), data: { state: "booting" } },
        { type: "state", at: at(505), data: { state: "testing" } },
        ...probeStep("hb1", "base", 200, 520, 11),
        ...probeStep("hb2", "base", 200, 525, 10),
        ...probeStep("hp1", "pr", 503, 530, 16),
        ...probeStep("hp2", "pr", 503, 535, 15),
        {
            type: "verdict",
            at: at(573),
            data: { verdictState: "regression", findings: 1 },
        },
        { type: "state", at: at(574), data: { state: "regression" } },
    ]);

export const SUMDB_ERROR_LINE =
    'go: verifying module github.com/Masterminds/semver/v3@v3.4.0: Get "https://sum.golang.org/lookup/github.com/!masterminds/semver/v3@v3.4.0": dial tcp: lookup sum.golang.org on 10.213.68.128:53: no such host';

export const BOOT_TITLE =
    "The build checks github.com/Masterminds/semver/v3@v3.4.0 against the Go checksum database, which the sandbox does not reach";

export const sumdbBootFailure = (): NonNullable<RuntimeRun["bootFailure"]> => ({
    side: "pr",
    kind: "platform",
    signature: "platform:go_checksum_db",
    title: BOOT_TITLE,
    errorLine: SUMDB_ERROR_LINE,
    logTail: [
        "#11 [grafana builder 3/9] COPY go.mod go.sum ./",
        "#11 DONE 0.1s",
        "#12 [grafana builder 4/9] RUN go mod download",
        "#12 0.412 go: downloading github.com/Masterminds/semver/v3 v3.4.0",
        "#12 0.907 go: downloading github.com/prometheus/client_golang v1.20.5",
        `#12 12.03 ${SUMDB_ERROR_LINE}`,
        '#12 ERROR: process "/bin/sh -c go mod download" did not complete successfully: exit code: 1',
        "------",
        " > [grafana builder 4/9] RUN go mod download:",
        'failed to solve: process "/bin/sh -c go mod download" did not complete successfully: exit code: 1',
    ],
    at: at(240),
});

/** PR #6: the PR's build needs a host the sandbox does not reach, so its paths stay untested. */
export const bootFailureRun = (
    patch: Partial<RuntimeRun> = {},
): RuntimeRun => ({
    ...baseRun,
    runId: "run-boot",
    repositoryName: "kodus/demo-grafana",
    prNumber: 6,
    state: "partly_tested",
    verdictState: "partly_tested",
    check: { conclusion: "neutral", title: "Partly tested" },
    reason: "the cell could not start the PR's machine (platform:platform:go_checksum_db); not attributed to the PR",
    exploration: undefined,
    probes: [],
    uncoveredEntryPoints: ["GET /api/health"],
    uncovered: [
        {
            entryPoint: "GET /api/health",
            reason: "blocker",
            blocker: { kind: "platform" },
        },
    ],
    phaseMs: undefined,
    bootFailure: sumdbBootFailure(),
    ...patch,
});

/** PR #6 as the Run recorded it before the build reached the checksum mirror: this PR does not boot, main does. */
export const bootRegressionRun = (
    patch: Partial<RuntimeRun> = {},
): RuntimeRun => {
    const boot = {
        probeId: "boot",
        entryPoint: "boot",
        verdict: "finding" as const,
        findingKind: "pr_destabilizes_machine" as const,
        reason: "the PR does not boot while the base does: platform:go_checksum_db",
    };
    return bootFailureRun({
        state: "regression",
        verdictState: "regression",
        check: { conclusion: "failure", title: "1 regression" },
        reason: undefined,
        uncoveredEntryPoints: [],
        uncovered: [],
        probes: [boot],
        findings: [boot],
        ...patch,
    });
};

/**
 * A route this PR adds, as the gate records it today: main has no such route
 * (404), this PR answers what the probe expected before it ran (200), and
 * the request block carries the status, so the gate's first difference is
 * the request although the request is the same.
 */
export const newRouteLanes = (): NonNullable<
    NonNullable<RuntimeRun["probes"]>[number]["lanes"]
> => {
    const captured = { requests: true, logs: true, db: true, outbound: true };
    const base = {
        side: "base" as const,
        round: 1,
        stepId: "nb1",
        t0: at(520),
        windowMs: 30,
        events: [
            {
                kind: "request" as const,
                at: 3,
                label: "GET /orders/export → 404",
            },
            {
                kind: "log" as const,
                at: 20,
                service: "web",
                label: "GET /orders/export 404 1.2ms",
            },
            { kind: "response" as const, at: 22, label: "status 404" },
        ],
        captured,
        artifacts: [],
        truncated: false,
    };
    const pr = {
        side: "pr" as const,
        round: 1,
        stepId: "np1",
        t0: at(530),
        windowMs: 120,
        events: [
            {
                kind: "request" as const,
                at: 5,
                label: "GET /orders/export → 200",
            },
            {
                kind: "log" as const,
                at: 100,
                service: "web",
                label: "GET /orders/export 200 95.4ms",
            },
            { kind: "response" as const, at: 108, label: "status 200" },
        ],
        captured,
        artifacts: [],
        truncated: false,
    };
    return {
        base,
        pr,
        firstDifference: {
            index: 0,
            kind: "request",
            base: base.events[0],
            pr: pr.events[0],
        },
    };
};

export const newRouteRun = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
    ...baseRun,
    runId: "run-new-route",
    state: "regression",
    verdictState: "regression",
    check: { conclusion: "failure", title: "1 regression" },
    exploration: undefined,
    probes: [
        {
            probeId: "orders-export",
            entryPoint: "GET /orders/export",
            verdict: "finding",
            intent: "unintended",
            reason: "status differs",
            differingFields: ["status"],
            baseStepIds: ["nb1", "nb2"],
            prStepIds: ["np1", "np2"],
            lanes: newRouteLanes(),
        },
    ],
    probeRequests: {
        "orders-export": {
            kind: "http",
            method: "GET",
            service: "web",
            port: 3000,
            path: "/orders/export",
            purpose: "Export the orders as CSV",
            expected: "200",
        },
    },
    uncoveredEntryPoints: [],
    ...patch,
});

export const newRouteView = () =>
    reduceRunStream([
        { type: "state", at: at(0), data: { state: "queued" } },
        { type: "state", at: at(20), data: { state: "booting" } },
        { type: "state", at: at(505), data: { state: "testing" } },
        ...probeStep("nb1", "base", 404, 520, 22),
        ...probeStep("nb2", "base", 404, 525, 21),
        ...probeStep("np1", "pr", 200, 530, 108),
        ...probeStep("np2", "pr", 200, 535, 104),
        {
            type: "verdict",
            at: at(573),
            data: { verdictState: "regression", findings: 1 },
        },
        { type: "state", at: at(574), data: { state: "regression" } },
    ]);
