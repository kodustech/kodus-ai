/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { TooltipProvider } from "@components/ui/tooltip";
import { render, screen } from "@testing-library/react";

import type { BYOKConfigV2 } from "../_types";
import { ByokPageClient } from "./page.client";

/**
 * Render ByokPageClient under a TooltipProvider — production supplies one at the
 * app root (app/layout.tsx), so the tooltip-using cards (CuratedModelCard in the
 * first-run card, model-card metric tags) have an ambient provider. This wrapper
 * reproduces that layout-level context for the isolated render.
 */
const renderPage = (ui: React.ReactElement) =>
    render(<TooltipProvider>{ui}</TooltipProvider>);

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

// The interactive Models tab (04-08) writes via revalidateServerSidePath, which
// imports next/cache → next's server request code that references the `Request`
// web global (absent in jsdom). Stub the server-only util to keep this render
// spec hermetic — revalidation is not exercised by a pure render assertion.
jest.mock("src/core/utils/revalidate-server-side", () => ({
    revalidateServerSidePath: jest.fn(),
    revalidateServerSideTag: jest.fn(),
}));

// The Models tab + first-run card call useRouter, and magicModal reads
// usePathname. next/navigation has no app-router context under jsdom, so provide
// inert hooks.
jest.mock("next/navigation", () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => "/organization/byok",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
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

        renderPage(
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

    it("disables Routing + Budget on first run and shows the single-decision card", () => {
        renderPage(
            <ByokPageClient config={null} llmConfigStatus={llmConfigStatus} />,
        );

        // 04-08: first-run now renders the D-UI-FIRSTRUN single-decision card
        // (recommended model + key + Connect), replacing the read-only tracer's
        // "No model connected yet" placeholder.
        expect(
            screen.getByText("Recommended for code review"),
        ).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Routing/ })).toBeDisabled();
        expect(screen.getByRole("tab", { name: /Budget/ })).toBeDisabled();
    });
});
