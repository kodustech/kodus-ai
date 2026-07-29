/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import type { BYOKConfigV2 } from "../_types";
import { ByokPageClient } from "./page.client";

// ModelOverridesBanner (rendered by ByokPageClient) fetches overrides in a
// useEffect; stub the service so the spec never hits the network. Passing no
// teamId already short-circuits the fetch, but the mock keeps it hermetic.
jest.mock("@services/organizationParameters/fetch", () => ({
    listModelOverrides: jest
        .fn()
        .mockResolvedValue({ overrides: [], mismatchedCount: 0 }),
    clearModelOverrides: jest.fn(),
}));

// SpendLimitSection (wrapped by BudgetTab) transitively imports @services/fetch
// → next-auth, which is ESM-only and Jest cannot parse. Stub it — the budget
// tab is out of scope for this v2-read tracer spec.
jest.mock("./spend-limit-section", () => ({
    SpendLimitSection: () => <div data-testid="spend-limit-section" />,
}));

const llmConfigStatus = {
    source: "byok",
    byok: { configured: true },
    env: { configured: false },
} as never;

describe("ByokPageClient — v2 read path", () => {
    it("renders config.models[] grouped by provider (managed excluded) and enables Routing/Budget", () => {
        const config: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: "cred-byok", provider: "openai", apiKey: "sk-abcd1234wxyz" },
                { id: "cred-managed", provider: "google_gemini", managed: true },
            ],
            models: [
                { id: "m1", credentialId: "cred-byok", model: "test-model-alpha" },
                { id: "m2", credentialId: "cred-byok", model: "test-model-beta" },
                {
                    id: "m3",
                    credentialId: "cred-managed",
                    model: "managed-model-gamma",
                },
            ],
        };

        render(
            <ByokPageClient config={config} llmConfigStatus={llmConfigStatus} />,
        );

        // Both models on the non-managed credential appear, grouped under the
        // provider header.
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("test-model-alpha")).toBeInTheDocument();
        expect(screen.getByText("test-model-beta")).toBeInTheDocument();

        // The managed credential's model is never rendered.
        expect(
            screen.queryByText("managed-model-gamma"),
        ).not.toBeInTheDocument();

        // The raw key is never rendered — only a masked form.
        expect(
            screen.queryByText("sk-abcd1234wxyz"),
        ).not.toBeInTheDocument();

        // With a connected model, Routing + Budget are interactive.
        expect(
            screen.getByRole("tab", { name: /Routing/ }),
        ).not.toBeDisabled();
        expect(
            screen.getByRole("tab", { name: /Budget/ }),
        ).not.toBeDisabled();
    });

    it("disables Routing + Budget on first run (no connected model)", () => {
        render(
            <ByokPageClient config={null} llmConfigStatus={llmConfigStatus} />,
        );

        expect(screen.getByText("No model connected yet")).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Routing/ })).toBeDisabled();
        expect(screen.getByRole("tab", { name: /Budget/ })).toBeDisabled();
    });
});
