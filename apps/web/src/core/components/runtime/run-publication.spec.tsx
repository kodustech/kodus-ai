/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { RunPublication } from "@services/runtime/contracts";
import { render, screen } from "@testing-library/react";

import { RunPublicationStatus } from "./run-publication";

const publication = (patch: Partial<RunPublication> = {}): RunPublication => ({
    postsToPullRequest: true,
    check: { status: "published", at: "2026-11-06T12:00:00.000Z" },
    comment: { status: "pending", retrying: true, showing: "reporting" },
    settled: false,
    ...patch,
});

describe("RunPublicationStatus", () => {
    it("shows the check and the comment as the product recorded them", () => {
        render(<RunPublicationStatus publication={publication()} />);
        expect(screen.getByText("Check")).toBeInTheDocument();
        expect(screen.getByText("On the pull request")).toBeInTheDocument();
        expect(screen.getByText("Retrying")).toBeInTheDocument();
        expect(
            screen.getByText("The last delivery failed; Kodus is retrying."),
        ).toBeInTheDocument();
    });

    it("a simulation says it posts nothing, and never 'Published'", () => {
        render(
            <RunPublicationStatus
                publication={publication({
                    postsToPullRequest: false,
                    check: { status: "not_expected" },
                    comment: { status: "not_expected" },
                    settled: true,
                })}
            />,
        );
        expect(screen.getByRole("note")).toHaveTextContent(
            "Simulation: Kodus posts nothing on the pull request for this Run.",
        );
        expect(screen.queryByText(/published/i)).not.toBeInTheDocument();
    });

    it("renders nothing without the record (an older API)", () => {
        const { container } = render(
            <RunPublicationStatus publication={undefined} />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});
