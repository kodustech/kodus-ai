/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { TrialTermsAlert } from "./trial-terms-alert";

const useTrialTermsMock = jest.fn();
jest.mock("../_hooks/use-trial-terms", () => ({
    useTrialTerms: () => useTrialTermsMock(),
}));

const terms = (trialDays: number, trialReviewCreditsIncluded: number) =>
    useTrialTermsMock.mockReturnValue({
        trialDays,
        trialReviewCreditsIncluded,
    });

describe("TrialTermsAlert", () => {
    it.each([
        ["loading or failed", undefined],
        ["no terms (self-hosted)", null],
        [
            "a trial with no Kodus-paid reviews",
            { trialDays: 7, trialReviewCreditsIncluded: 0 },
        ],
    ])("renders nothing while %s", (_label, value) => {
        useTrialTermsMock.mockReturnValue(value);
        const { container } = render(
            <TrialTermsAlert variant="repositories" />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("states billing's numbers before the first review", () => {
        terms(7, 5);
        render(<TrialTermsAlert variant="repositories" />);
        expect(
            screen.getByText("Your first 5 PR reviews are on us"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                /During your 7-day trial we cover your first 5 PR reviews/,
            ),
        ).toBeInTheDocument();
    });

    it("says which review the first PR uses", () => {
        terms(14, 5);
        render(<TrialTermsAlert variant="pull-request" />);
        expect(
            screen.getByText(/this review uses 1 of the 5 we cover for you/),
        ).toBeInTheDocument();
    });

    it("reads right with a single included review", () => {
        terms(7, 1);
        render(<TrialTermsAlert variant="pull-request" />);
        expect(
            screen.getByText("Your first PR review is on us"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/this review is the one we cover for you/),
        ).toBeInTheDocument();
    });
});
