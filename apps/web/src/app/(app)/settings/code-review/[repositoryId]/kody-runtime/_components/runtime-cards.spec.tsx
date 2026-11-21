/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { WhatKodyChecks } from "./runtime-cards";

// What a branch protection that requires the check lets through (owner
// decision of 2026-11-18): a partly tested Run that left something to decide
// asks for action and blocks; only a Run with nothing to test is neutral.
describe("WhatKodyChecks", () => {
    it("says a partly tested Run blocks a required check, and only nothing to test is neutral", () => {
        render(<WhatKodyChecks />);
        const note = screen.getByText(/branch protection/i);
        expect(note).toHaveTextContent(/partly tested/i);
        expect(note).toHaveTextContent(/blocks the merge/i);
        expect(note).toHaveTextContent(
            /only a Run with nothing to test ends neutral/i,
        );
        expect(note).not.toHaveTextContent(/passes on neutral/i);
    });
});
