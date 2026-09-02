/** @jest-environment jsdom */
// @ts-nocheck
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@components/ui/tooltip";

import { PrListItem } from "./pr-list-item";

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
