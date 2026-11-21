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
            <RunFindingsView
                runId="run-1"
                findings={[]}
                compared
                newEndpoints={1}
            />,
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

describe("progressive disclosure of the findings", () => {});

describe("new behavior that matches what the PR expected", () => {
    const announced = () => buildFindings(newRouteRun(), newRouteView().steps);
});
