import type { RunStreamEvent, RunStreamPage } from "./contracts";
import {
    followRunStream,
    parseStreamResponse,
    QUIET_STREAM_IDLE_DELAY_MS,
    reduceRunStream,
    RunStreamFatalError,
    streamBackoffMs,
} from "./stream";

const headers = (h: Record<string, string> = {}) => ({
    get: (name: string) => h[name] ?? null,
});

const ev = (
    type: RunStreamEvent["type"],
    data: Record<string, unknown>,
    at = "2026-10-29T10:00:00Z",
): RunStreamEvent => ({ type, at, data });

describe("reduceRunStream", () => {
    it("keeps the states in order and drops a repeated one", () => {
        const view = reduceRunStream([
            ev("state", { state: "queued" }),
            ev("state", { state: "booting" }),
            ev("state", { state: "booting" }),
            ev("state", { state: "testing" }),
            ev("state", { state: "not-a-state" }),
        ]);
        expect(view.states.map((s) => s.state)).toEqual([
            "queued",
            "booting",
            "testing",
        ]);
    });

    it("joins step.started and step.finished of one step", () => {
        const view = reduceRunStream([
            ev(
                "step.started",
                {
                    stepId: "s1",
                    side: "pr",
                    kind: "http",
                    purpose: "empty cart",
                },
                "t1",
            ),
            ev(
                "step.started",
                { stepId: "s2", side: "base", kind: "http" },
                "t2",
            ),
            ev(
                "step.finished",
                {
                    stepId: "s1",
                    durationMs: 212,
                    status: 200,
                    verdict: "finding",
                },
                "t3",
            ),
        ]);
        expect(view.steps).toEqual([
            {
                stepId: "s1",
                side: "pr",
                kind: "http",
                label: "empty cart",
                startedAt: "t1",
                finishedAt: "t3",
                durationMs: 212,
                status: 200,
                verdict: "finding",
                exitCode: undefined,
                probeId: undefined,
                transport: undefined,
            },
            expect.objectContaining({ stepId: "s2", startedAt: "t2" }),
        ]);
    });

    it("keeps the step outcome, the phase counts and the verdict's facts, never phase text", () => {
        const view = reduceRunStream([
            ev("phase", {
                phase: "agent",
                entryPoints: ["a", "b"],
                note: "free text",
            }),
            ev("phase", { phase: "replay", probes: 3, explored: 4 }),
            ev("step.started", { stepId: "s1", side: "base", kind: "exec" }),
            ev("step.finished", {
                stepId: "s1",
                outcome: "timeout",
                vmHealth: "ok",
            }),
            ev("verdict", {
                verdictState: "partly_tested",
                findings: 0,
                intended: 1,
                uncovered: ["GET /x", 3],
                forcedNeutral: ["1 blocked outbound request"],
                rejectedProbes: 2,
                rejectedReasons: [
                    "test: the test command must run the file it names",
                    7,
                ],
            }),
        ]);
        expect(view.phases.map((p) => p.counts)).toEqual([
            { entryPoints: 2 },
            { probes: 3, explored: 4 },
        ]);
        expect(view.steps[0]).toMatchObject({
            outcome: "timeout",
            vmHealth: "ok",
        });
        expect(view.verdict).toMatchObject({
            findings: undefined,
            intended: 1,
            uncovered: ["GET /x"],
            forcedNeutral: ["1 blocked outbound request"],
            rejectedProbes: 2,
            rejectedReasons: [
                "test: the test command must run the file it names",
            ],
        });
    });

    it("continues from a previous view, as the live loop appends pages", () => {
        const first = reduceRunStream([ev("state", { state: "testing" })]);
        const second = reduceRunStream(
            [
                ev("verdict", {
                    verdictState: "regression",
                    check: { conclusion: "failure", title: "1 regression" },
                }),
                ev("published", { kind: "comment" }),
            ],
            first,
        );
        expect(second.states).toHaveLength(1);
        expect(second.verdict?.check).toEqual({
            conclusion: "failure",
            title: "1 regression",
        });
        expect(second.published).toHaveLength(1);
        expect(first.published).toHaveLength(0);
    });
});

describe("parseStreamResponse", () => {
    it("reads the page from the API envelope", () => {
        const page = parseStreamResponse(
            {
                data: {
                    events: [ev("phase", { phase: "boot" })],
                    nextOffset: "b2",
                    upToDate: false,
                },
            },
            headers(),
        );
        expect(page).toEqual({
            events: [ev("phase", { phase: "boot" })],
            nextOffset: "b2",
            upToDate: false,
        });
    });

    it("takes the offset and up-to-date from the headers for a bare array", () => {
        const page = parseStreamResponse(
            [ev("phase", { phase: "boot" }), { junk: true }],
            headers({
                "Stream-Next-Offset": "abc",
                "Stream-Up-To-Date": "true",
            }),
        );
        expect(page.events).toHaveLength(1);
        expect(page.nextOffset).toBe("abc");
        expect(page.upToDate).toBe(true);
    });

    it("keeps the offset it asked with when the answer carries none", () => {
        expect(parseStreamResponse(null, headers(), "o5").nextOffset).toBe(
            "o5",
        );
    });
});

describe("followRunStream", () => {
    const page = (p: Partial<RunStreamPage>): RunStreamPage => ({
        events: [],
        nextOffset: "x",
        upToDate: true,
        ...p,
    });

    it("resumes from the last offset after a dropped connection, losing nothing", async () => {
        const offsets: Array<string | undefined> = [];
        const answers: Array<RunStreamPage | Error> = [
            page({
                events: [ev("state", { state: "booting" })],
                nextOffset: "o1",
                upToDate: false,
            }),
            new Error("network down"),
            page({
                events: [ev("state", { state: "testing" })],
                nextOffset: "o2",
                upToDate: false,
            }),
            page({
                events: [
                    ev("state", { state: "no_regressions" }),
                    ev("published", { kind: "check" }),
                ],
                nextOffset: "o3",
                upToDate: true,
            }),
        ];
        const seen: RunStreamEvent[] = [];
        const statuses: string[] = [];
        await followRunStream({
            signal: new AbortController().signal,
            readPage: async (offset) => {
                offsets.push(offset);
                const next = answers.shift()!;
                if (next instanceof Error) throw next;
                return next;
            },
            onEvents: (events) => seen.push(...events),
            onStatus: (s) => statuses.push(s),
            wait: async () => undefined,
        });
        expect(offsets).toEqual([undefined, "o1", "o1", "o2"]);
        expect(seen.map((e) => e.data.state ?? e.type)).toEqual([
            "booting",
            "testing",
            "no_regressions",
            "published",
        ]);
        expect(statuses).toContain("reconnecting");
        expect(statuses.at(-1)).toBe("done");
    });

    it("reads nothing while the tab is hidden, says it is paused, and resumes from its offset once visible", async () => {
        // WP8: a forgotten tab on a quiet Run long-polled the API forever.
        let hidden = true;
        let show: () => void = () => undefined;
        const offsets: Array<string | undefined> = [];
        const statuses: string[] = [];
        const answers = [
            page({ events: [ev("state", { state: "testing" })], nextOffset: "o1" }),
            page({ events: [ev("state", { state: "no_regressions" }), ev("published", { kind: "check" })], nextOffset: "o2" }),
        ];
        const followed = followRunStream({
            signal: new AbortController().signal,
            readPage: async (offset) => {
                offsets.push(offset);
                return answers.shift()!;
            },
            onEvents: () => undefined,
            onStatus: (s) => statuses.push(s),
            wait: async () => undefined,
            isHidden: () => hidden,
            untilVisible: () => new Promise<void>((resolve) => (show = resolve)),
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(offsets).toEqual([]);
        expect(statuses).toEqual(["paused"]);
        hidden = false;
        show();
        await followed;
        expect(offsets).toEqual([undefined, "o1"]);
        expect(statuses.at(-1)).toBe("done");
    });

    it("waits longer between empty reads once the Run has been quiet for a long time", async () => {
        let now = 0;
        const waits: number[] = [];
        const readPage = jest.fn().mockResolvedValue(page({ nextOffset: "o1" }));
        const controller = new AbortController();
        await followRunStream({
            signal: controller.signal,
            readPage,
            onEvents: () => undefined,
            wait: async (ms) => {
                waits.push(ms);
                now += 20_000 + ms;
                if (waits.length >= 40) controller.abort();
            },
            now: () => now,
        });
        expect(waits[0]).toBe(1000);
        expect(waits.at(-1)).toBe(QUIET_STREAM_IDLE_DELAY_MS);
    });

    it("stops after two empty reads past a terminal state with no publish", async () => {
        const readPage = jest
            .fn()
            .mockResolvedValueOnce(
                page({
                    events: [ev("state", { state: "superseded" })],
                    nextOffset: "o1",
                }),
            )
            .mockResolvedValue(page({ nextOffset: "o1" }));
        await followRunStream({
            signal: new AbortController().signal,
            readPage,
            onEvents: () => undefined,
            wait: async () => undefined,
        });
        expect(readPage).toHaveBeenCalledTimes(3);
    });

    it("waits for a stream that does not exist yet", async () => {
        const readPage = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                page({
                    events: [
                        ev("state", { state: "cancelled" }),
                        ev("published", {}),
                    ],
                }),
            );
        const wait = jest.fn(async () => undefined);
        await followRunStream({
            signal: new AbortController().signal,
            readPage,
            onEvents: () => undefined,
            wait,
        });
        expect(readPage).toHaveBeenCalledTimes(2);
        expect(wait).toHaveBeenCalledWith(2000, expect.anything());
    });

    it("reports a stream that never appears instead of polling forever", async () => {
        const readPage = jest.fn().mockResolvedValue(null);
        const statuses: string[] = [];
        await expect(
            followRunStream({
                signal: new AbortController().signal,
                readPage,
                onEvents: () => undefined,
                onStatus: (s) => statuses.push(s),
                wait: async () => undefined,
                maxMissingReads: 3,
            }),
        ).rejects.toMatchObject({
            name: "RunStreamFatalError",
            statusCode: 404,
        });
        expect(readPage).toHaveBeenCalledTimes(3);
        expect(statuses).toEqual(["waiting", "waiting"]);
    });

    it("a missing stream of a Run already terminal ends as done", async () => {
        const statuses: string[] = [];
        await followRunStream({
            signal: new AbortController().signal,
            readPage: async () => null,
            onEvents: () => undefined,
            onStatus: (s) => statuses.push(s),
            isTerminal: () => true,
            wait: async () => undefined,
        });
        expect(statuses).toEqual(["done"]);
    });

    it("gives up on an answer a retry cannot fix", async () => {
        await expect(
            followRunStream({
                signal: new AbortController().signal,
                readPage: async () => {
                    throw new RunStreamFatalError("forbidden", 403);
                },
                onEvents: () => undefined,
                wait: async () => undefined,
            }),
        ).rejects.toThrow("forbidden");
    });

    it("stops reading once aborted", async () => {
        const controller = new AbortController();
        const readPage = jest.fn(async () => {
            controller.abort();
            return page({ upToDate: false });
        });
        await followRunStream({
            signal: controller.signal,
            readPage,
            onEvents: () => undefined,
            wait: async () => undefined,
        });
        expect(readPage).toHaveBeenCalledTimes(1);
    });

    it("backs off up to 15 s between failed reads", () => {
        expect(streamBackoffMs(1)).toBe(1000);
        expect(streamBackoffMs(3)).toBe(4000);
        expect(streamBackoffMs(10)).toBe(15_000);
    });
});
