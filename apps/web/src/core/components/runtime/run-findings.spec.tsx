/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import {
    healthRegressionRun,
    healthRegressionView,
    newRouteRun,
    newRouteView,
    regressionRun,
    regressionView,
} from "@services/runtime/model/__fixtures__/run-detail";
import { buildFindings } from "@services/runtime/model/findings";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RunFindingsView } from "./run-findings";

jest.mock("@services/runtime/queries", () => ({
    useFindingFeedback: jest.fn(),
    useRunReproduction: () => ({ isPending: true }),
}));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: ReactNode;
    }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
// Its media hook reads the API client (next-auth); browser-evidence.spec.tsx covers it.
jest.mock("./browser-evidence", () => ({ BrowserEvidence: () => null }));
jest.mock("./evidence-link", () => ({
    EvidenceLink: ({ children }: { children: ReactNode }) => (
        <button type="button">{children}</button>
    ),
}));

const findings = () => buildFindings(regressionRun(), regressionView().steps);

describe("RunFindingsView", () => {
    it("shows the regression first with both sides, the proof and the reproduce action", () => {
        render(<RunFindingsView runId="run-2" findings={findings()} />);
        const [regression, intended] = screen.getAllByRole("article");
        expect(within(regression).getByText("Regression")).toBeInTheDocument();
        expect(
            within(regression).getByText(
                "status 201 → 500 · json.error differs",
            ),
        ).toBeInTheDocument();
        expect(
            within(regression).getByText(/2 attempts on main and 2 on this PR/),
        ).toBeInTheDocument();
        expect(within(regression).getAllByText("Raw response")).toHaveLength(4);
        expect(
            within(regression).getByRole("button", {
                name: "Reproduction data: POST /orders",
            }),
        ).toBeInTheDocument();

        expect(
            within(intended).getByText("Changed, as the PR intends"),
        ).toBeInTheDocument();
        expect(within(intended).getByRole("note")).toHaveTextContent(
            /not counted as a regression/,
        );
        expect(
            within(intended).queryByRole("button", {
                name: /Reproduction data/,
            }),
        ).not.toBeInTheDocument();
    });

    it("votes per finding", () => {
        const onVote = jest.fn();
        render(
            <RunFindingsView
                runId="run-2"
                findings={findings()}
                onVote={onVote}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Useful: POST /orders" }),
        );
        expect(onVote).toHaveBeenCalledWith("orders-coupon", "up");
    });

    it("has an empty state that says what a finding would show", () => {
        render(<RunFindingsView runId="run-1" findings={[]} />);
        expect(screen.getByText("No findings")).toBeInTheDocument();
        expect(
            screen.getByText(/base version and this PR answered the same/),
        ).toBeInTheDocument();
    });

    it("does not say main and this PR answered the same when the PR adds a route main lacks", () => {
        render(
            <RunFindingsView runId="run-1" findings={[]} compared newEndpoints={1} />,
        );
        expect(screen.getByText("No findings")).toBeInTheDocument();
        expect(
            screen.getByText(/Apart from the route this PR adds/),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/^On every path Kody reached/),
        ).not.toBeInTheDocument();
    });

    it("does not claim main and this PR agreed when nothing was compared", () => {
        render(
            <RunFindingsView runId="run-1" findings={[]} compared={false} />,
        );
        expect(screen.getByText("Nothing was compared")).toBeInTheDocument();
        expect(
            screen.queryByText(/main and this PR answered the same/),
        ).not.toBeInTheDocument();
    });

    it("says the finding is missing from the record instead of 'nothing compared'", () => {
        render(
            <RunFindingsView
                runId="run-1"
                findings={[]}
                compared={false}
                missing
            />,
        );
        expect(
            screen.getByText("The finding is not in this Run's record yet"),
        ).toBeInTheDocument();
    });

    it("shows the request once, with what was expected, and the file the route reaches", () => {
        const run = regressionRun({
            probeRequests: {
                "orders-coupon": {
                    kind: "http",
                    method: "POST",
                    service: "web",
                    port: 3000,
                    path: "/orders",
                    purpose: "Order with a coupon",
                    expected: "201 with the discounted total",
                },
            },
        });
        run.probes = run.probes!.map((p) =>
            p.probeId === "orders-coupon"
                ? { ...p, via: "src/orders/coupon.ts" }
                : p,
        );
        render(
            <RunFindingsView
                runId="run-2"
                findings={buildFindings(run, regressionView().steps)}
            />,
        );
        const [regression] = screen.getAllByRole("article");
        expect(
            within(regression).getAllByText("Request sent to both"),
        ).toHaveLength(1);
        expect(
            within(regression).getByText("POST web:3000/orders"),
        ).toBeInTheDocument();
        expect(
            within(regression).getByText("201 with the discounted total"),
        ).toBeInTheDocument();
        expect(
            within(regression).getByText("src/orders/coupon.ts"),
        ).toBeInTheDocument();
        expect(
            within(regression).getByText(/Kody's mapping/),
        ).toBeInTheDocument();
    });

    it("links Kody's review comment and marks a regression intended, then offers to undo", () => {
        const run = regressionRun();
        const linked = {
            ...run,
            findings: run.findings?.map((f) => ({
                ...f,
                suggestionId: "sugg-1",
            })),
            probes: run.probes?.map((p) => ({ ...p, suggestionId: "sugg-1" })),
        };
        const onMarkIntended = jest.fn();
        const { rerender } = render(
            <RunFindingsView
                runId="run-2"
                findings={buildFindings(linked, regressionView().steps)}
                onMarkIntended={onMarkIntended}
            />,
        );
        const [regression, intended] = screen.getAllByRole("article");
        expect(
            within(regression).getByRole("link", {
                name: "Kody's review comment",
            }),
        ).toHaveAttribute(
            "href",
            expect.stringContaining("?suggestion=sugg-1"),
        );
        fireEvent.click(
            within(regression).getByRole("button", {
                name: "This change is intended",
            }),
        );
        expect(onMarkIntended).toHaveBeenCalledWith("orders-coupon", true);
        // Kody already read the other one as intended: nothing to mark.
        expect(
            within(intended).queryByRole("button", { name: /intended/ }),
        ).not.toBeInTheDocument();

        rerender(
            <RunFindingsView
                runId="run-2"
                findings={buildFindings(
                    {
                        ...linked,
                        intendedBy: {
                            "orders-coupon": {
                                userId: "u-1",
                                at: "2026-11-06T18:00:00.000Z",
                                mine: true,
                            },
                        },
                    },
                    regressionView().steps,
                )}
                onMarkIntended={onMarkIntended}
            />,
        );
        const [marked] = screen.getAllByRole("article");
        expect(
            within(marked).getByText(/You marked this as an intended change/),
        ).toHaveTextContent(
            /the check and the PR comment still show what Kody measured/,
        );
        fireEvent.click(
            within(marked).getByRole("button", { name: "Undo intended" }),
        );
        expect(onMarkIntended).toHaveBeenLastCalledWith("orders-coupon", false);
    });

    it("offers no mark to a viewer who may not make one", () => {
        render(<RunFindingsView runId="run-2" findings={findings()} />);
        expect(
            screen.queryByRole("button", { name: "This change is intended" }),
        ).not.toBeInTheDocument();
    });
});

describe("a finding with back-end evidence", () => {
    const health = () =>
        buildFindings(healthRegressionRun(), healthRegressionView().steps);

    it("leads with what happened, from the structured fields, and links the code on GitHub", () => {
        render(
            <RunFindingsView
                runId="run-health"
                findings={health()}
                pullRequestUrl="https://github.com/kodus/demo-grafana/pull/4"
            />,
        );
        // The answers are the finding's one line, on its row; the rest of the story opens with it.
        const [card] = screen.getAllByRole("article");
        expect(card.querySelector("summary")).toHaveTextContent(
            "GET /api/health answered 503 on this PR and 200 on main.",
        );
        const story = screen.getByRole("region", { name: "What happened" });
        expect(story).not.toHaveTextContent("answered 503");
        expect(story).toHaveTextContent(
            "First difference: app log database is locked at +12 ms",
        );
        expect(
            within(story).getByRole("link", {
                name: /pkg\/api\/health\.go:23/,
            }),
        ).toHaveAttribute(
            "href",
            expect.stringMatching(
                /^https:\/\/github\.com\/kodus\/demo-grafana\/blob\/[0-9a-f]{40}\/pkg\/api\/health\.go#L23$/,
            ),
        );
    });

    it("keeps the code ref as plain text without the PR's URL", () => {
        render(<RunFindingsView runId="run-health" findings={health()} />);
        const story = screen.getByRole("region", { name: "What happened" });
        expect(within(story).queryByRole("link")).toBeNull();
        expect(story).toHaveTextContent("Changed in pkg/api/health.go:23.");
    });

    it("shows the response diff, and keeps the replay closed with its takeaway on the summary", () => {
        render(<RunFindingsView runId="run-health" findings={health()} />);
        const table = screen.getByRole("table", {
            name: "Fields that differ in the answer",
        });
        expect(within(table).getByText('"failing"')).toBeInTheDocument();
        expect(within(table).getByText("removed")).toBeInTheDocument();
        const replay = screen.getByRole("region", {
            name: "Replay of GET /api/health on main and this PR",
        });
        const details = replay.querySelector("details")!;
        expect(details.open).toBe(false);
        expect(details.querySelector("summary")).toHaveTextContent(
            "Step-by-step replay" +
                "Same request; main answered 200 at +11 ms, this PR 503 at +16 ms; app logs differed first (this PR: database is locked at +12 ms); outbound calls also differed; database not captured.",
        );
        const first = replay.querySelectorAll("[data-first-difference]");
        expect(first).toHaveLength(2);
        expect(first[1]).toHaveTextContent("database is locked");
        // Requests and the database have nothing on either side: no row says "not captured" twice.
        expect(
            within(replay).queryByRole("rowheader", { name: "Request" }),
        ).toBeNull();
        expect(
            within(replay).queryByRole("rowheader", { name: "Database" }),
        ).toBeNull();
        expect(within(replay).queryByText(/not captured on this/)).toBeNull();
        expect(
            within(replay).getAllByRole("button", { name: /App logs of/ }),
        ).toHaveLength(2);
    });

    it("renders an older finding without any of it", () => {
        render(<RunFindingsView runId="run-2" findings={findings()} />);
        expect(screen.queryByRole("region", { name: /Replay/ })).toBeNull();
        expect(
            screen.queryByRole("table", {
                name: "Fields that differ in the answer",
            }),
        ).toBeNull();
    });
});

describe("progressive disclosure of the findings", () => {
    it("opens the first finding and keeps the others to one row each", () => {
        render(<RunFindingsView runId="run-2" findings={findings()} />);
        const [regression, intended] = screen
            .getAllByRole("article")
            .map((a) => a.querySelector("details")!);
        expect(regression.open).toBe(true);
        expect(intended.open).toBe(false);
        // A closed row still says what it is.
        expect(intended.querySelector("summary")).toHaveTextContent(
            "Changed, as the PR intends",
        );
        expect(intended.querySelector("summary")).toHaveTextContent(
            "GET /orders/:id",
        );
    });

    it("keeps the evidence closed, with how sure Kody is on its summary", () => {
        render(<RunFindingsView runId="run-2" findings={findings()} />);
        const [regression] = screen.getAllByRole("article");
        const evidence = [
            ...regression.querySelectorAll("details details"),
        ].find((d) =>
            d.querySelector("summary")?.textContent?.startsWith("Evidence"),
        ) as HTMLDetailsElement;
        expect(evidence.open).toBe(false);
        expect(evidence.querySelector("summary")).toHaveTextContent(
            "EvidenceSame request, 2 attempts on main and 2 on this PR, the same answer every attempt.",
        );
        expect(within(evidence).getAllByText("Raw response")).toHaveLength(4);
    });
});

describe("new behavior that matches what the PR expected", () => {
    const announced = () => buildFindings(newRouteRun(), newRouteView().steps);

    it("is not drawn as a regression, and says so plainly", () => {
        render(
            <RunFindingsView runId="run-new-route" findings={announced()} />,
        );
        const [card] = screen.getAllByRole("article");
        expect(card).not.toHaveClass("ring-danger/40");
        expect(
            within(card).getByText("New behavior · confirm it"),
        ).toBeInTheDocument();
        expect(within(card).queryByText("Regression")).toBeNull();
        expect(within(card).getByRole("note")).toHaveTextContent(
            /^New behavior that matches what this PR says it does: confirm it is intended\./,
        );
        expect(card.querySelector(".text-danger.font-mono.text-lg")).toBeNull();
    });

    it("makes 'This change is intended' its prominent action", () => {
        const onMarkIntended = jest.fn();
        render(
            <RunFindingsView
                runId="run-new-route"
                findings={announced()}
                onMarkIntended={onMarkIntended}
            />,
        );
        const mark = screen.getByRole("button", {
            name: "This change is intended",
        });
        expect(mark.className).toContain("primary-dark");
        fireEvent.click(mark);
        expect(onMarkIntended).toHaveBeenCalledWith("orders-export", true);
    });
});
