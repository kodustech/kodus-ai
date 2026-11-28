import type { RuntimeHealth, RuntimeHealthStuck } from "../contracts";
import {
    blockerHref,
    costTodayLine,
    HEALTH_NOT_MEASURED,
    healthSummaryTiles,
    stuckHref,
    stuckLine,
} from "./health";

const health = (over: Partial<RuntimeHealth> = {}): RuntimeHealth => ({
    organizationId: "org-1",
    at: "2026-11-12T12:00:00.000Z",
    summary: {
        setups: { measured: true, active: 3, blocked: 1, settingUp: 0 },
        runs: {
            measured: true,
            days: 7,
            total: 5,
            byVerdict: { no_regressions: 4, regression: 1 },
        },
        boot: {
            measured: true,
            thisWeek: { count: 5, p50Ms: 90_000, p95Ms: 240_000 },
            lastWeek: { count: 4, p50Ms: 80_000, p95Ms: 120_000 },
            trend: "slower",
        },
    },
    stuck: { measured: true, items: [], notChecked: [] },
    errors: { measured: true, days: 7, bySignature: [] },
    cells: {
        measured: true,
        items: [],
        pool: { measured: false, reason: "r" },
    },
    cost: {
        today: {
            measured: true,
            llmUsd: 0.5,
            machineUsd: null,
            totalUsd: null,
            complete: false,
            gbMinutes: 30,
            vcpuMinutes: null,
        },
        usagePath: "/runtime/settings/usage",
    },
    ...over,
});
const usd = (v: number | null) => (v === null ? "—" : `US$ ${v.toFixed(2)}`);

describe("the Health screen's words", () => {
    it("says how long an item has been stuck and the longest its state should take", () => {
        const run: RuntimeHealthStuck = {
            subject: "run",
            state: "queued",
            since: "",
            ageMs: 40 * 60_000,
            boundMs: 35 * 60_000,
            runId: "r1",
            link: { kind: "run", runId: "r1" },
        };
        expect(stuckLine(run)).toBe(
            "Run waiting in the queue for 40 min 00 s; it should take at most 35 min 00 s",
        );
        expect(stuckHref(run)).toBe("/runtime/runs/r1");
        const machine: RuntimeHealthStuck = {
            subject: "claim",
            state: "bound",
            since: "",
            ageMs: 5 * 60_000,
            boundMs: 0,
            link: { kind: "none" },
        };
        expect(stuckLine(machine)).toBe(
            "Machine holding its machine, 5 min 00 s past its hard time limit",
        );
        expect(stuckHref(machine)).toBeUndefined();
    });

    it("links an error to the environment's blocker card first, else to the Run", () => {
        expect(blockerHref({ environmentId: "env a", runId: "r1" })).toBe(
            "/runtime/environments/env%20a",
        );
        expect(blockerHref({ runId: "r1" })).toBe("/runtime/runs/r1");
    });

    it("shows the summary, and Not measured with the reason where the API could not read a part", () => {
        expect(
            healthSummaryTiles(health()).map((t) => [t.label, t.value]),
        ).toEqual([
            ["Environments ready", "3"],
            ["Runs, last 7 days", "5"],
            ["Boot time, last 7 days", "1 min 30 s / 4 min 00 s"],
            ["Stuck now", "0"],
        ]);
        const missing = healthSummaryTiles(
            health({
                summary: {
                    ...health().summary,
                    setups: { measured: false, reason: "No database" },
                },
            }),
        );
        expect(missing[0]).toEqual({
            label: "Environments ready",
            value: HEALTH_NOT_MEASURED,
            hint: "No database",
        });
    });

    it("gives today's total only when both parts are priced, and says which part is missing", () => {
        expect(costTodayLine(health(), usd)).toEqual({
            value: HEALTH_NOT_MEASURED,
            hint: "US$ 0.50 LLM · 30 GB·min of machines, not priced",
        });
        const priced = health({
            cost: {
                today: {
                    measured: true,
                    llmUsd: 0.5,
                    machineUsd: 0.25,
                    totalUsd: 0.75,
                    complete: true,
                    gbMinutes: 30,
                    vcpuMinutes: 10,
                },
                usagePath: "",
            },
        });
        expect(costTodayLine(priced, usd)).toEqual({
            value: "US$ 0.75",
            hint: "US$ 0.50 LLM · US$ 0.25 machines",
        });
    });

    it("says today's machines on the org's own hosts are priced at its price per host-hour, or where to set one", () => {
        const today = health().cost.today;
        const own = health({
            cost: {
                today: {
                    ...today,
                    measured: true,
                    machineUsd: 0.25,
                    totalUsd: 0.75,
                    complete: true,
                    ownHostUsdPerHour: 0.8,
                } as RuntimeHealth["cost"]["today"],
                usagePath: "",
            },
        });
        expect(costTodayLine(own, usd)).toEqual({
            value: "US$ 0.75",
            hint: "US$ 0.50 LLM · US$ 0.25 machines, your hosts at $0.8/h",
        });
        const cell = {
            cellId: "cell-own",
            owner: "customer" as const,
            status: "connected",
            connected: true,
            lastHeartbeatAt: null,
            freeSlots: 1,
            isolation: null,
            driver: "docker-gvisor",
            maxClaimMemoryMb: null,
            maxClaimCpus: null,
        };
        const unpriced = health({
            cells: {
                measured: true,
                items: [cell],
                pool: { measured: false, reason: "r" },
            },
        });
        expect(costTodayLine(unpriced, usd).hint).toBe(
            "US$ 0.50 LLM · 30 GB·min of machines, not priced: set a price per host-hour in Runtime settings",
        );
    });
});

describe("settingsStatusLine", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { settingsStatusLine } = require("./health");
    const health = (over: Record<string, unknown> = {}) =>
        ({
            stuck: { measured: true, items: [], notChecked: [] },
            summary: {
                setups: { measured: true, active: 1, blocked: 0, settingUp: 0 },
            },
            cells: { measured: true, items: [{ connected: true }], pool: {} },
            ...over,
        }) as never;

    it("says it works and counts connected cells", () => {
        expect(settingsStatusLine(health())).toEqual({
            ok: true,
            text: "Working · 1 host connected",
        });
    });
    it("names the problem in one line", () => {
        expect(
            settingsStatusLine(
                health({
                    stuck: { measured: true, items: [{}, {}], notChecked: [] },
                }),
            ),
        ).toEqual({ ok: false, text: "2 items stuck" });
    });
});
