/** @jest-environment jsdom */
// @ts-nocheck
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

// decision-tab-gate imports decision-tab, which reaches the API service
// layer; stub it so the suite does not pull next-auth into the root jest.
jest.mock("@services/fetch", () => ({
    authorizedFetch: jest.fn(),
}));

import { DecisionTabGate } from "./decision-tab-gate";

const HEAD = "a1b2c3d4";

describe("DecisionTabGate", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("renders nothing when the flag is off", () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;
        render(
            <DecisionTabGate
                repositoryId="repo-1"
                prNumber={142}
                headSha={HEAD}
                flagEnabled={false}
            />,
        );
        expect(screen.queryByTestId("decision-panel")).not.toBeInTheDocument();
        expect(screen.queryByTestId("decision-loading")).not.toBeInTheDocument();
    });

    it("renders the DecisionTab when the flag is on", () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;
        render(
            <DecisionTabGate
                repositoryId="repo-1"
                prNumber={142}
                headSha={HEAD}
                flagEnabled={true}
            />,
        );
        // The tab shows the loading state initially (fetch is async).
        expect(screen.getByTestId("decision-loading")).toBeInTheDocument();
    });
});
