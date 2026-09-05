/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RotatePanel } from "./rotate-panel";

// The panel probes the credential before persisting. Both probes succeed here —
// what is under test is WHAT gets saved, not the probe.
jest.mock("@services/organizationParameters/fetch", () => ({
    testBYOK: jest.fn(async () => ({ ok: true, latencyMs: 1 })),
    testBYOKModel: jest.fn(async () => ({ ok: true, latencyMs: 1 })),
}));

jest.mock("@services/organizationParameters/hooks", () => ({
    useSuspenseGetLLMProviders: () => ({
        providers: [
            { id: "open_router", name: "OpenRouter", requiresBaseURL: false },
        ],
    }),
    useModelCapabilities: () => ({ data: undefined }),
}));

/**
 * "Edit provider" must not delete what it does not show.
 *
 * The server REPLACES a credential's `settings` with whatever the client sends,
 * carrying over only the encrypted aws* fields. This panel rebuilds that object
 * from its own form — so every field it fails to render and seed is a field it
 * silently erases, in a save the user made to rotate a KEY.
 *
 * Today that erasure is latent, not observed: with nothing in its form the panel
 * omits `settings` altogether and the builder keeps what is stored, so it only
 * bites a credential that also carries a field this panel DOES render. What was
 * observed is the other half — the pin is stored on the credential and rendered
 * in the add-model flow, but could not be seen or changed from here at all.
 *
 * So these assert the contract directly: the panel shows what is stored, and a
 * save re-sends every key, including ones no form owns.
 */
const credential = {
    id: "cred-main",
    provider: "open_router",
    apiKey: "sk-••••abc",
    settings: {
        openrouterProviderOrder: ["moonshot", "together"],
        openrouterAllowFallbacks: false,
        // A setting no credential form owns — written by another screen or a
        // newer API. The panel has no field for it and must still not drop it.
        futureKnob: 7,
    },
};

const renderPanel = () => {
    const onSave = jest.fn(
        async (_apiKey: string, _settings?: Record<string, unknown>) => { },
    );
    render(
        <RotatePanel
            credential={credential as any}
            onSave={onSave}
            onCancel={() => { }}
        />,
    );
    return onSave;
};

const save = () => {
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
};

describe("RotatePanel — a key rotation must not erase the credential's settings", () => {
    it("shows the provider's advanced fields, seeded from what is stored", () => {
        renderPanel();

        expect(screen.getByDisplayValue("moonshot, together")).toBeVisible();
    });

    it("re-sends the pin untouched when the user only rotates the key", async () => {
        const onSave = renderPanel();

        save();

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const [, settings] = onSave.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ];
        expect(settings.openrouterProviderOrder).toEqual([
            "moonshot",
            "together",
        ]);
        expect(settings.openrouterAllowFallbacks).toBe(false);
    });

    it("carries through a stored setting no form owns", async () => {
        const onSave = renderPanel();

        save();

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const [, settings] = onSave.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ];
        expect(settings.futureKnob).toBe(7);
    });

    it("lets the user edit the pin here, and saves what they typed", async () => {
        const onSave = renderPanel();

        const input = screen.getByDisplayValue("moonshot, together");
        fireEvent.change(input, { target: { value: "baseten, fireworks" } });
        fireEvent.blur(input);
        save();

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const [, settings] = onSave.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ];
        expect(settings.openrouterProviderOrder).toEqual([
            "baseten",
            "fireworks",
        ]);
    });

    it("keeps the stored key: a blank field saves an empty string, never the mask", async () => {
        const onSave = renderPanel();

        save();

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        const [apiKey] = onSave.mock.calls[0];
        expect(apiKey).toBe("");
    });
});

describe("RotatePanel — what a test result is allowed to claim", () => {
    const renderWith = (result: Record<string, unknown>) => {
        const { testBYOKModel } = jest.requireMock(
            "@services/organizationParameters/fetch",
        ) as { testBYOKModel: jest.Mock };
        testBYOKModel.mockResolvedValueOnce(result);
        render(
            <RotatePanel
                credential={credential as any}
                probeModelId="deepseek/deepseek-v4-pro"
                onSave={async () => {}}
                onCancel={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /^test$/i }));
    };

    it("shows what the PROVIDER said, not only our reading of the status", async () => {
        // The reason lands here already — the API returns it — and the screen
        // dropped it. A customer regenerated a good key for a day while the
        // sentence naming the real fix sat one field away, unrendered.
        renderWith({
            ok: false,
            code: "not_found",
            latencyMs: 5,
            message: "The provider returned 404 for this request.",
            providerMessage:
                "your account's allowed-providers setting permits only: groq, z-ai",
        });

        expect(
            await screen.findByText(/allowed-providers setting permits only/i),
        ).toBeVisible();
    });

    it("does not claim the model runs when only the catalog was checked", async () => {
        // Listing is not routing: the id can sit in the catalog while every real
        // call to it is refused. The weaker check must not borrow the stronger
        // check's words.
        renderWith({ ok: true, code: "ok", latencyMs: 405, verifiedBy: "catalog" });

        expect(await screen.findByText(/doesn't call the model/i)).toBeVisible();
        expect(screen.queryByText(/credential authenticates/i)).toBeNull();
    });

    it("still makes the strong claim for a real probe", async () => {
        renderWith({ ok: true, code: "ok", latencyMs: 405, verifiedBy: "probe" });

        expect(
            await screen.findByText(/credential authenticates/i),
        ).toBeVisible();
    });
});
