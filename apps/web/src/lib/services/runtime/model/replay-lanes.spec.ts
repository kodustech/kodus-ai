import { healthLanes, newRouteLanes } from "./__fixtures__/run-detail";
import {
    buildReplayLanes,
    formatOffset,
    hasLaneEvents,
    laneArtifactLabel,
    laneSpanMs,
} from "./replay-lanes";
import { plainText } from "./rich-text";

describe("replay lanes", () => {
    it("puts both sides on one clock, block by block in lane order", () => {
        const view = buildReplayLanes(healthLanes());
        expect(view.spanMs).toBe(48);
        expect(view.rows.map((r) => r.label)).toEqual([
            "Request",
            "App logs",
            "Database",
            "Outbound",
            "Response",
        ]);
        const response = view.rows[4];
        expect(response.base).toEqual({
            captured: true,
            events: [
                expect.objectContaining({
                    label: "status 200",
                    offset: "+11 ms",
                }),
            ],
        });
        // The PR's response sits at 16 of 48 ms on the shared clock.
        expect(
            view.pr.track.find((e) => e.kind === "response")?.position,
        ).toBeCloseTo((16 / 48) * 100);
    });

    it("says a block the cell did not capture, and never calls it empty", () => {
        const view = buildReplayLanes(healthLanes());
        expect(view.rows[0]).toMatchObject({
            kind: "request",
            base: { captured: false },
            pr: { captured: false },
        });
        expect(view.rows[2].base).toEqual({ captured: false });
        // Outbound was captured: main made no call, this PR one that was blocked.
        expect(view.rows[3].base).toEqual({ captured: true, events: [] });
        expect(view.rows[3].pr).toMatchObject({
            captured: true,
            events: [{ label: "grafana.com:443 blocked" }],
        });
    });

    it("marks the first difference once per side, in its block", () => {
        const view = buildReplayLanes(healthLanes());
        expect(view.firstDifference).toMatchObject({
            kind: "log",
            pr: { label: "database is locked", offset: "+12 ms", first: true },
            base: { first: true },
        });
        expect(view.rows.filter((r) => r.differs).map((r) => r.kind)).toEqual([
            "log",
        ]);
        expect(view.pr.track.filter((e) => e.first)).toHaveLength(1);
    });

    it("has no first difference when the lanes match", () => {
        const { firstDifference: _fd, ...same } = healthLanes();
        const view = buildReplayLanes(same);
        expect(view.firstDifference).toBeUndefined();
        expect(view.rows.some((r) => r.differs)).toBe(false);
        expect(view.pr.track.some((e) => e.first)).toBe(false);
    });

    it("lists each side's artifacts by what they are, with their size", () => {
        const view = buildReplayLanes(healthLanes());
        expect(view.base.artifacts).toEqual([
            { type: "logs", label: "App logs", detail: "2 KB" },
        ]);
        expect(view.pr.stepId).toBe("hp1");
    });

    it("flags a cell that captured nothing but the answer", () => {
        const lanes = healthLanes();
        const none = {
            requests: false,
            logs: false,
            db: false,
            outbound: false,
        };
        const view = buildReplayLanes({
            base: { ...lanes.base, captured: none },
            pr: { ...lanes.pr, captured: none },
        });
        expect(view.base.capturedNothing).toBe(true);
        expect(view.rows[1].pr).toEqual({ captured: false });
    });
});

describe("the replay's takeaway", () => {
    it("says the request was the same and only the answer differed, with when each side answered", () => {
        const view = buildReplayLanes(newRouteLanes(), "main");
        expect(plainText(view.takeaway)).toBe(
            "Same request; main answered 404 at +22 ms, this PR 200 at +108 ms; app logs, database and outbound calls did not differ.",
        );
    });

    it("does not call the request the first difference when only its answer differs", () => {
        const view = buildReplayLanes(newRouteLanes(), "main");
        expect(view.firstDifference?.kind).toBe("response");
        expect(view.rows.filter((r) => r.differs).map((r) => r.kind)).toEqual([
            "response",
        ]);
        expect(
            view.pr.track.filter((e) => e.first).map((e) => e.label),
        ).toEqual(["status 200"]);
    });

    it("names the block that parted first, what else differed and what was not captured", () => {
        const view = buildReplayLanes(healthLanes(), "main");
        expect(plainText(view.takeaway)).toBe(
            "Same request; main answered 200 at +11 ms, this PR 503 at +16 ms; app logs differed first (this PR: database is locked at +12 ms); outbound calls also differed; database not captured.",
        );
    });

    it("says both answered the same when the lanes match", () => {
        const { firstDifference: _fd, ...lanes } = newRouteLanes();
        const same = {
            ...lanes,
            pr: { ...lanes.base, side: "pr" as const, stepId: "np1" },
        };
        expect(plainText(buildReplayLanes(same, "main").takeaway)).toBe(
            "Same request; both answered 404; app logs, database and outbound calls did not differ.",
        );
    });

    it("leaves out a block with nothing on either side, captured or not", () => {
        const view = buildReplayLanes(healthLanes(), "main");
        // Requests and the database: not captured on either side.
        expect(view.rows.filter((r) => !r.empty).map((r) => r.kind)).toEqual([
            "log",
            "outbound",
            "response",
        ]);
        const quiet = buildReplayLanes(newRouteLanes(), "main");
        // Database and outbound: captured on both, nothing happened.
        expect(quiet.rows.filter((r) => r.empty).map((r) => r.kind)).toEqual([
            "db",
            "outbound",
        ]);
    });
});

describe("formatOffset", () => {
    it("reads ms under a second and seconds above", () => {
        expect(formatOffset(0)).toBe("+0 ms");
        expect(formatOffset(12.4)).toBe("+12 ms");
        expect(formatOffset(1_200)).toBe("+1.2 s");
        expect(formatOffset(3_000)).toBe("+3 s");
        expect(formatOffset(42_500)).toBe("+43 s");
        expect(formatOffset(-5)).toBe("+0 ms");
    });
});

describe("laneSpanMs", () => {
    it("is the longer window or last event, never 0", () => {
        const lanes = healthLanes();
        expect(laneSpanMs(lanes)).toBe(48);
        expect(
            laneSpanMs({
                base: { ...lanes.base, windowMs: undefined, events: [] },
                pr: { ...lanes.pr, windowMs: undefined, events: [] },
            }),
        ).toBe(1);
    });
});

describe("laneArtifactLabel", () => {
    it("names every upload type", () => {
        expect(laneArtifactLabel("screenshot-0")).toBe("Screenshot 1");
        expect(laneArtifactLabel("pixeldiff-2")).toBe("Pixel diff 3");
        expect(laneArtifactLabel("db")).toBe("Database changes");
        expect(laneArtifactLabel("cast")).toBe("Terminal recording");
        expect(laneArtifactLabel("har")).toBe("Network log (HAR)");
        expect(laneArtifactLabel("video")).toBe("Video");
        expect(laneArtifactLabel("trace")).toBe("Browser trace");
    });
});

describe("hasLaneEvents", () => {
    it("is false for no lanes or two empty sides", () => {
        expect(hasLaneEvents(undefined)).toBe(false);
        const lanes = healthLanes();
        expect(hasLaneEvents(lanes)).toBe(true);
        expect(
            hasLaneEvents({
                base: { ...lanes.base, events: [] },
                pr: { ...lanes.pr, events: [] },
            }),
        ).toBe(false);
    });
});
