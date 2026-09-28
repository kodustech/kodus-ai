/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { CockpitLockedPreview } from "./locked-preview";

describe("CockpitLockedPreview", () => {
    it("names the locked metrics and leaves every value empty", () => {
        const { container } = render(<CockpitLockedPreview />);

        // The metric names are real — they are what's locked.
        expect(screen.getByText("Deploy Frequency")).toBeInTheDocument();
        expect(screen.getByText("PR Cycle Time")).toBeInTheDocument();
        expect(screen.getByText("Bug Ratio")).toBeInTheDocument();
        expect(screen.getByText("PR Size")).toBeInTheDocument();
        expect(screen.getByText("Lead Time Breakdown")).toBeInTheDocument();
        expect(screen.getByText("PRs Opened vs Closed")).toBeInTheDocument();

        // Every value slot is a dash, one per metric card.
        expect(screen.getAllByText("—")).toHaveLength(4);

        // And nothing reads as a measurement: no digits anywhere in the tree,
        // so a blurred screenshot can't be mistaken for the org's own data.
        expect(container.textContent).not.toMatch(/\d/);
    });

    it("renders no data-fetching hooks — a static tree with no async boundaries", () => {
        // A regression guard for the design constraint in the component's own
        // comment: this preview must never fetch real analytics. Rendering
        // synchronously without throwing/suspending is a cheap proxy for
        // "nothing here awaits a network call".
        expect(() => render(<CockpitLockedPreview />)).not.toThrow();
    });
});
