/** @jest-environment jsdom */
// @ts-nocheck
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@components/ui/tooltip";

import { PrListItem, ReviewNotices } from "./pr-list-item";

// The row only reaches outside itself for the display timezone and the review
// prefetch; neither has anything to do with the link under test.
jest.mock("@services/organizationParameters/hooks", () => ({
    useGetTimezone: () => "UTC",
}));

jest.mock("@services/pull-requests", () => {
    const actual = jest.requireActual("@services/pull-requests/utils");
    return {
        ...actual,
        usePrefetchPullRequestReview: () => jest.fn(),
    };
});

const execution = (overrides = {}) => ({
    prId: "pr-1",
    prNumber: 42,
    repositoryId: "repo-1",
    repositoryName: "kodus-ai",
    title: "feat: something",
    headBranchRef: "feature",
    merged: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    author: { name: "someone" },
    suggestionsCount: { sent: 3, filtered: 1 },
    ...overrides,
});

const group = (latest) => ({
    prId: latest.prId,
    latest,
    executions: [latest],
    reviewCount: 1,
});

// The row is full of Radix tooltips, which need their provider in scope.
const renderRow = (latest) =>
    render(
        <TooltipProvider>
            <PrListItem group={group(latest)} />
        </TooltipProvider>,
    );

/**
 * The suggestion count is the entry point the Cloud evaluator used and could
 * not follow (issue #1728): on a large PR it dropped them at the top of the
 * diff. It only lands on the finding if the backend's firstSentSuggestion
 * actually reaches this href — the piece no other test covers.
 */
describe("PrListItem — suggestion count link", () => {
    // Several things in the row link to the review page (the title among
    // them); target the count link by its accessible name, not by href.
    const countLink = () =>
        screen.getByRole("link", {
            name: "Open review at the delivered suggestions",
        });

    it("deep-links to the first delivered suggestion when the backend supplies one", () => {
        renderRow(
            execution({
                firstSentSuggestion: {
                    id: "sugg-abc",
                    filePath: "src/deep/file.ts",
                },
            }),
        );

        expect(countLink()).toHaveAttribute(
            "href",
            "/pull-requests/repo-1/42?file=src%2Fdeep%2Ffile.ts&suggestion=sugg-abc",
        );
    });

    it("falls back to the plain review URL when there is no delivered suggestion", () => {
        renderRow(execution({ firstSentSuggestion: null }));

        expect(countLink()).toHaveAttribute("href", "/pull-requests/repo-1/42");
    });

    it("still renders a usable link when the field is absent entirely (older API response)", () => {
        renderRow(execution());

        expect(countLink()).toHaveAttribute("href", "/pull-requests/repo-1/42");
    });
});

const warning = (overrides = {}) => ({
    kind: "PROMPT_COMPACTED",
    reason: "small_context_window",
    contextWindowTokens: 16000,
    modelName: "llama",
    ...overrides,
});

/**
 * #2066: a review that lost its checkout, its call graph or some findings is
 * not a context-window counter-measure, and must not read as one ("has a
 * context window of 0 tokens").
 */
describe("ReviewNotices — each loss under its own cause", () => {
    it("lists a lost checkout as a review that ran with less context", () => {
        render(
            <ReviewNotices
                warnings={[
                    warning({
                        kind: "SANDBOX_UNAVAILABLE",
                        reason: "sandbox_unavailable",
                        contextWindowTokens: 0,
                        detail: "read only the diff",
                    }),
                ]}
            />,
        );

        expect(
            screen.getByText("Review ran with less context"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Reviewed the diff only (repository not checked out)",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Review fidelity reduced"),
        ).not.toBeInTheDocument();
    });

    it("keeps small-context-window counter-measures in the fidelity notice", () => {
        render(
            <ReviewNotices
                warnings={[
                    warning(),
                    warning({
                        kind: "RULE_CONTEXT_UNAVAILABLE",
                        reason: "lookup_unavailable",
                        contextWindowTokens: 0,
                    }),
                ]}
            />,
        );

        expect(screen.getByText("Review fidelity reduced")).toBeInTheDocument();
        expect(
            screen.getByText("Review ran with less context"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Kody Rules not evaluated (repository context unavailable)",
            ),
        ).toBeInTheDocument();
    });
});
