/** @jest-environment jsdom */
// @ts-nocheck
import "@testing-library/jest-dom";

import { render, screen, waitFor } from "@testing-library/react";

jest.mock("@services/fetch", () => ({
    authorizedFetch: jest.fn(),
}));

import { authorizedFetch } from "@services/fetch";

import { DecisionTab } from "./decision-tab";

const authorizedFetchMock = authorizedFetch as jest.Mock;

const SNAP = "cfg=v11;model=kodus-managed;head=test";
const HEAD = "a1b2c3d4";

function buildReadyPayload<T>(value: T) {
    return { status: "Ready", value, snapshotKey: SNAP };
}
function buildUnavailableSnapshot(reason: string) {
    return { status: "Unavailable", reason, snapshotKey: SNAP };
}
function buildStaleSnapshot(prior: string) {
    return { status: "Stale", snapshotKey: SNAP, priorSnapshotKey: prior };
}

function fullPayload(gates: {
    l0?: unknown;
    l1?: unknown;
    l2?: unknown;
    l3?: unknown;
}) {
    return {
        organizationId: "org-1",
        repositoryId: "repo-1",
        prNumber: 142,
        headSha: HEAD,
        baseSha: "b2c3d4e5",
        configurationKey: SNAP,
        gateVerdictsSnapshot: {
            snapshotKey: SNAP,
            capturedAt: "2026-11-20T13:50:00.000Z",
            ...gates,
        },
        lastApplyOutcome: {
            kind: "applied" as const,
            steps: [],
            decidedAt: "2026-11-20T13:50:00.000Z",
        },
        lastReconciledAt: "2026-11-20T13:50:00.000Z",
        consecutiveFailures: 0,
        inFlightTriggerKind: null,
    };
}

describe("DecisionTab", () => {
    beforeEach(() => {
        authorizedFetchMock.mockReset();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function renderTab(props: Partial<Parameters<typeof DecisionTab>[0]> = {}) {
        return render(
            <DecisionTab
                repositoryId="repo-1"
                prNumber={142}
                headSha={HEAD}
                pollMs={60_000}
                {...props}
            />,
        );
    }

    it("renders a loading state initially", () => {
        authorizedFetchMock.mockReturnValue(new Promise(() => {}));
        renderTab();
        expect(screen.getByTestId("decision-loading")).toBeInTheDocument();
    });

    it("renders the applied state and four ready gate rows once data arrives", async () => {
        authorizedFetchMock.mockResolvedValue(
            fullPayload({
                l0: buildReadyPayload([]),
                l1: buildReadyPayload({
                    riskScore: 0.16,
                    level: "LOW",
                    blastRadius: { totalFunctions: 1, totalFiles: 1 },
                    testGaps: [],
                    vetoContributingFunctions: [],
                    factors: [],
                }),
                l2: buildReadyPayload({
                    riskIdentified: false,
                    reason: "clean",
                }),
                l3: buildReadyPayload({
                    matchedPolicyId: "docs/**",
                    unmatchedReasons: [],
                }),
            }),
        );

        renderTab();

        await waitFor(() => {
            expect(screen.getByTestId("decision-panel")).toBeInTheDocument();
        });
        expect(screen.getByText("applied")).toBeInTheDocument();
        expect(screen.getByText("L0 ready")).toBeInTheDocument();
        expect(screen.getByText("L1 ready")).toBeInTheDocument();
        expect(screen.getByText("L2 ready")).toBeInTheDocument();
        expect(screen.getByText("L3 ready")).toBeInTheDocument();
    });

    it("renders Unavailable and Stale gates distinctly", async () => {
        authorizedFetchMock.mockResolvedValue(
            fullPayload({
                l0: buildReadyPayload([]),
                l1: buildUnavailableSnapshot("ast graph not indexed"),
                l2: buildStaleSnapshot("cfg=v10"),
                l3: buildReadyPayload({
                    matchedPolicyId: "docs/**",
                    unmatchedReasons: [],
                }),
            }),
        );
        renderTab();

        await waitFor(() => {
            expect(screen.getByTestId("gate-L1-unavailable")).toBeInTheDocument();
        });
        expect(screen.getByTestId("gate-L1-unavailable")).toHaveTextContent(
            "ast graph not indexed",
        );
        expect(screen.getByTestId("gate-L2-stale")).toBeInTheDocument();
        expect(screen.getByTestId("gate-L2-stale")).toHaveTextContent("cfg=v10");
    });

    it("shows the retry banner when consecutiveFailures is non-zero", async () => {
        authorizedFetchMock.mockResolvedValue({
            ...fullPayload({
                l0: buildReadyPayload([]),
                l1: buildReadyPayload(null),
                l2: buildReadyPayload(null),
                l3: buildReadyPayload(null),
            }),
            consecutiveFailures: 2,
            lastApplyOutcome: {
                kind: "partial" as const,
                steps: [
                    {
                        step: "approve" as const,
                        result: {
                            status: "retry" as const,
                            reason: "rate-limited",
                        },
                    },
                ],
                decidedAt: "2026-11-20T13:50:00.000Z",
            },
        });
        renderTab();

        await waitFor(() => {
            expect(screen.getByTestId("decision-retry-banner")).toBeInTheDocument();
        });
        expect(screen.getByTestId("decision-retry-banner")).toHaveTextContent(
            "consecutive failures",
        );
    });

    it("renders the error state when fetch fails", async () => {
        authorizedFetchMock.mockRejectedValue({ statusCode: 500 });
        renderTab();
        await waitFor(() => {
            expect(screen.getByTestId("decision-error")).toBeInTheDocument();
        });
        expect(screen.getByTestId("decision-error")).toHaveTextContent("500");
    });

    it("calls the API through the same-origin proxy with the head sha", async () => {
        authorizedFetchMock.mockResolvedValue(fullPayload({}));
        renderTab();

        await waitFor(() => {
            expect(authorizedFetchMock).toHaveBeenCalled();
        });
        const [url, config] = authorizedFetchMock.mock.calls[0];
        expect(url).toContain("/api/proxy/api/pull-requests/repo-1/142/decision");
        expect(config.params.headSha).toBe(HEAD);
    });
});
