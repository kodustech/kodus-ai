import type { ReplayLanes } from "@libs/runtime/run/replay-lanes";

// The sample app's orders page (libs/runtime/protocol/fixtures/sample-app): main
// lists the seeded orders; the PR renamed a field, so its list renders
// empty and the button reads "Submit". Steps as the cell reports them.

const steps = (pr: boolean) => [
    {
        index: 0,
        kind: "goto" as const,
        label: "goto /",
        ok: true,
        startMs: 2_550,
        endMs: 3_110,
    },
    {
        index: 1,
        kind: "waitFor" as const,
        label: "waitFor body[data-state=ready]",
        ok: true,
        startMs: 3_110,
        endMs: 3_400,
    },
    {
        index: 2,
        kind: "screenshot" as const,
        label: "screenshot orders",
        ok: true,
        startMs: 3_400,
        endMs: 3_620,
        screenshot: "screenshot-0" as const,
        ...(pr ? { pixeldiff: "pixeldiff-0" as const, ratio: 0.0412 } : {}),
    },
    pr
        ? {
              index: 3,
              kind: "expectText" as const,
              label: 'expectText #orders "keyboard"',
              ok: false,
              error: "mismatch" as const,
              startMs: 3_620,
              endMs: 8_640,
              value: "",
              screenshot: "screenshot-1" as const,
          }
        : {
              index: 3,
              kind: "expectText" as const,
              label: 'expectText #orders "keyboard"',
              ok: true,
              startMs: 3_620,
              endMs: 3_700,
              value: "keyboard × 2\nmonitor × 1",
          },
];

export const browserLanes = (): ReplayLanes => ({
    base: {
        side: "base",
        round: 1,
        stepId: "0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d",
        t0: "2026-11-07T12:00:00.000Z",
        windowMs: 4_100,
        events: [
            { kind: "request", at: 3_150, label: "GET /orders → 200" },
            { kind: "response", at: 4_100, label: "4/4 steps passed" },
        ],
        captured: { requests: true, logs: false, db: false, outbound: false },
        artifacts: [
            { type: "screenshot-0", bytes: 48_211, truncated: false },
            { type: "video", bytes: 120_443, truncated: false },
            { type: "trace", bytes: 151_314, truncated: false },
            { type: "har", bytes: 12_040, truncated: false },
        ],
        truncated: false,
        browser: {
            steps: steps(false),
            videoStartMs: 2_540,
            console: [],
            network: [
                {
                    method: "GET",
                    url: "http://app.kody.internal:3000/",
                    status: 200,
                    at: 2_600,
                    ms: 9,
                },
                {
                    method: "GET",
                    url: "http://app.kody.internal:3000/orders",
                    status: 200,
                    at: 3_150,
                    ms: 6,
                },
            ],
            truncated: false,
        },
    },
    pr: {
        side: "pr",
        round: 1,
        stepId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        t0: "2026-11-07T12:01:00.000Z",
        windowMs: 9_100,
        events: [
            { kind: "request", at: 3_160, label: "GET /orders → 200" },
            { kind: "response", at: 9_100, label: "3/4 steps passed" },
        ],
        captured: { requests: true, logs: false, db: false, outbound: false },
        artifacts: [
            { type: "screenshot-0", bytes: 41_002, truncated: false },
            { type: "screenshot-1", bytes: 40_870, truncated: false },
            { type: "pixeldiff-0", bytes: 9_120, truncated: false },
            { type: "video", bytes: 260_100, truncated: false },
            { type: "trace", bytes: 180_220, truncated: false },
            { type: "har", bytes: 12_101, truncated: false },
        ],
        truncated: false,
        browser: {
            steps: steps(true),
            videoStartMs: 2_530,
            console: [
                {
                    level: "warning",
                    text: "order.qty is undefined",
                    at: 3_300,
                },
            ],
            network: [
                {
                    method: "GET",
                    url: "http://app.kody.internal:3000/",
                    status: 200,
                    at: 2_590,
                    ms: 8,
                },
                {
                    method: "GET",
                    url: "http://app.kody.internal:3000/orders",
                    status: 200,
                    at: 3_160,
                    ms: 7,
                },
            ],
            truncated: false,
        },
    },
    firstStepDifference: 3,
});
