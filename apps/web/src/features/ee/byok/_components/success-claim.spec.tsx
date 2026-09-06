/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { SuccessClaim } from "./success-claim";

/**
 * The banner on the Edit model screen — the one a customer actually read.
 *
 * It reported "Connection OK — provider responded in 405ms" for a check that
 * had only asked the provider whether the model id was in its catalog. The key
 * was fine and the id was listed, so the check passed; but every real call to
 * that model was being refused because the account allowed no upstream serving
 * it. The customer trusted the green, and went looking for the fault in the one
 * place it was not.
 *
 * These pin the distinction at the only place it is visible to a person.
 */
describe("SuccessClaim", () => {
    it("does not claim a connection when only the catalog was checked", () => {
        render(<SuccessClaim latencyMs={405} verifiedBy="catalog" />);

        expect(screen.queryByText(/Connection OK/i)).toBeNull();
    });

    it("says plainly that the model was not called", () => {
        render(<SuccessClaim latencyMs={405} verifiedBy="catalog" />);

        expect(screen.getByText(/doesn't call the model/i)).toBeVisible();
    });

    it("still makes the strong claim for a real probe", () => {
        render(<SuccessClaim latencyMs={405} verifiedBy="probe" />);

        expect(screen.getByText(/Connection OK/i)).toBeVisible();
    });

    it("treats an unmarked pass as the strong claim (existing behaviour)", () => {
        // Every path that predates the distinction is a real probe, so an
        // absent mark must keep reading as one — otherwise this fix would
        // downgrade every passing test in the product.
        render(<SuccessClaim latencyMs={12} />);

        expect(screen.getByText(/Connection OK/i)).toBeVisible();
    });

    it.each([[405], [12], [1603]])("always shows the latency (%pms)", (ms) => {
        render(<SuccessClaim latencyMs={ms} verifiedBy="catalog" />);

        expect(screen.getByText(String(ms) + "ms")).toBeVisible();
    });
});
