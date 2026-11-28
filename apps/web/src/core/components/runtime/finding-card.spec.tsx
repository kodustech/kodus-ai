/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { Finding } from "@services/runtime/model/findings";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { FindingCard } from "./run-findings";

jest.mock("@services/runtime/queries", () => ({
    useFindingFeedback: jest.fn(),
    useRunReproduction: () => ({ isPending: true }),
}));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));
jest.mock("./browser-evidence", () => ({ BrowserEvidence: () => null }));
jest.mock("./evidence-link", () => ({
    EvidenceLink: ({ children }: { children: ReactNode }) => (
        <button type="button">{children}</button>
    ),
}));

const side = (answer: string, status: number, s: "base" | "pr") => ({
    side: s,
    sha: "c76abde1111",
    answer,
    steady: true,
    rounds: [{ stepId: `${s}-1`, round: 1, answer, status, lost: false }],
});

const finding: Finding = {
    baseLabel: "main",
    probeId: "orders-qty",
    entryPoint: "POST /orders",
    route: "POST /orders",
    intended: false,
    change: "status 201 → 400",
    differingFields: ["body.error"],
    base: side("201", 201, "base"),
    pr: side("400", 400, "pr"),
    proof: "Same request, 1 attempt on main and 1 on this PR",
    evidenceKind: "http",
    reproducible: true,
    boot: false,
    destabilizes: false,
    purpose: "Exercise the order creation boundary",
    responseDiff: {
        truncated: false,
        fields: [{ path: "body.error", pr: "quantity must be at most 100" }],
    },
    diffRef: { file: "server.js", line: 2 },
};

const patch =
    "@@ -1,3 +1,3 @@\n const a = 1;\n-if (q > 1000) fail();\n+if (q > 100) fail();\n const b = 2;\n";

describe("FindingCard", () => {
    it("leads with the headline and shows the proof lines", () => {
        render(<FindingCard runId="r" finding={finding} />);
        expect(
            screen.getByRole("heading", {
                name: /POST \/orders now returns 400 instead of 201/,
            }),
        ).toBeInTheDocument();
        const proof = screen.getByRole("region", { name: "Proof" });
        expect(proof).toHaveTextContent("POST /orders");
        expect(proof).toHaveTextContent("main 201 Created");
        expect(proof).toHaveTextContent(
            'PR 400 Bad Request "quantity must be at most 100"',
        );
        expect(screen.getByText("Regression")).toBeInTheDocument();
    });

    it("shows the diff hunk with the hit line marked", () => {
        const { container } = render(
            <FindingCard runId="r" finding={finding} patchOf={() => patch} />,
        );
        const where = screen.getByRole("region", { name: "Where" });
        expect(
            within(where).getByText("if (q > 100) fail();"),
        ).toBeInTheDocument();
        expect(
            within(where).getByText("if (q > 1000) fail();"),
        ).toBeInTheDocument();
        expect(container.querySelectorAll("[data-hit]")).toHaveLength(1);
    });

    it("falls back to the file and line without a hunk", () => {
        render(<FindingCard runId="r" finding={finding} />);
        const where = screen.getByRole("region", { name: "Where" });
        expect(where).toHaveTextContent("server.js:2");
        expect(where.querySelector("pre")).toBeNull();
    });

    it("keeps Details collapsed and the old step wording out of the default view", () => {
        const { container } = render(
            <FindingCard runId="r" finding={finding} />,
        );
        expect(container.querySelector("details")).not.toHaveAttribute("open");
        expect(screen.queryByText(/stable base/i)).not.toBeInTheDocument();
        const details = container.querySelector("details")!;
        for (const el of screen.queryAllByText(/attempt 1/))
            expect(details).toContainElement(el);
    });

    it("offers the actions in one row", () => {
        const onVote = jest.fn();
        const onMark = jest.fn();
        render(
            <FindingCard
                runId="r"
                finding={finding}
                onVote={onVote}
                onMarkIntended={onMark}
            />,
        );
        expect(
            screen.getByRole("button", {
                name: "Reproduction data: POST /orders",
            }),
        ).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", { name: "Mark as intended" }),
        );
        expect(onMark).toHaveBeenCalledWith(true);
        fireEvent.click(
            screen.getByRole("button", { name: "Useful: POST /orders" }),
        );
        expect(onVote).toHaveBeenCalledWith("up");
    });
});
