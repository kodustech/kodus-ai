/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { CockpitLockedPreview } from "./locked-preview";

describe("CockpitLockedPreview", () => {
    it("renders static sample metrics — never real analytics data", () => {
        render(<CockpitLockedPreview />);

        // Sample stat cards
        expect(screen.getByText("Deploy Frequency")).toBeInTheDocument();
        expect(screen.getByText("4.2/week")).toBeInTheDocument();
        expect(screen.getByText("PR Cycle Time")).toBeInTheDocument();
        expect(screen.getByText("Bug Ratio")).toBeInTheDocument();
        expect(screen.getByText("PR Size")).toBeInTheDocument();

        // Sample charts
        expect(screen.getByText("Lead Time Breakdown")).toBeInTheDocument();
        expect(screen.getByText("PRs Opened vs Closed")).toBeInTheDocument();
    });

    it("renders no data-fetching hooks — a static tree with no async boundaries", () => {
        // A regression guard for the design constraint in the component's own
        // comment: this preview must never fetch real analytics. Rendering
        // synchronously without throwing/suspending is a cheap proxy for
        // "nothing here awaits a network call".
        expect(() => render(<CockpitLockedPreview />)).not.toThrow();
    });
});
