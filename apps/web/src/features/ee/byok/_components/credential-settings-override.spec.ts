import { credentialSettingsOverride } from "./credential-settings-override";

/**
 * The decision that turned a fix into a regression.
 *
 * Sending settings is an instruction to replace; omitting them is the only way
 * to say "keep what is stored". A screen that never saw the stored settings has
 * nothing to instruct with, and saying so is the difference between a save that
 * adds a model and a save that quietly empties a credential.
 */
const PIN = { openrouterProviderOrder: ["moonshot"] };

describe("credentialSettingsOverride", () => {
    it("speaks when editing a model — the form was seeded from the credential", () => {
        expect(
            credentialSettingsOverride({
                isEditing: true,
                lockedProvider: undefined,
                settings: PIN,
            }),
        ).toEqual(PIN);
    });

    it("speaks when the provider was fixed at mount (?provider=)", () => {
        expect(
            credentialSettingsOverride({
                isEditing: false,
                lockedProvider: "open_router",
                settings: PIN,
            }),
        ).toEqual(PIN);
    });

    it("stays silent when the user picks the provider inside the form", () => {
        // The regression, pinned: nothing was seeded, so the object is whatever
        // the form happened to hold — and passing it would replace the stored
        // settings with it.
        expect(
            credentialSettingsOverride({
                isEditing: false,
                lockedProvider: undefined,
                settings: PIN,
            }),
        ).toBeUndefined();
    });

    it("stays silent for an unseeded form even when it built an EMPTY object", () => {
        // The exact shape that shipped: `{}` reads as "delete them all".
        expect(
            credentialSettingsOverride({
                isEditing: false,
                lockedProvider: undefined,
                settings: {},
            }),
        ).toBeUndefined();
    });

    it("still allows a deliberate clear from a seeded form", () => {
        // Silence must not swallow a real instruction: unpinning has to work.
        expect(
            credentialSettingsOverride({
                isEditing: true,
                lockedProvider: "open_router",
                settings: {},
            }),
        ).toEqual({});
    });
});
