import { credentialSettingsOverride } from "./credential-settings-override";

/**
 * The rule that both previous attempts got wrong, in opposite directions.
 *
 * Sending settings replaces them; omitting them keeps what is stored. Which is
 * right depends on whether the form SAW the stored values — the object alone
 * cannot say. Sending unconditionally erased a credential's pin when an unseeded
 * form had only `{}` to send. Then staying silent whenever unseeded threw away
 * settings the user had typed and watched "Test" validate.
 *
 * So the axis is authority, not size: a seeded form speaks for the credential
 * and may remove; an unseeded one may only add.
 */
const PIN = { openrouterProviderOrder: ["moonshot"] };
const STORED = { ...PIN, baseURL: "https://x", awsSecretAccessKey: "••••" };

describe("credentialSettingsOverride — a seeded form is authoritative", () => {
    it("passes what the form holds", () => {
        expect(
            credentialSettingsOverride({
                seeded: true,
                storedSettings: STORED,
                formSettings: PIN,
            }),
        ).toEqual(PIN);
    });

    it("lets an empty form CLEAR — unpinning has to work", () => {
        // Absence means removal here, because the field opened with the value
        // in it and the user took it out.
        expect(
            credentialSettingsOverride({
                seeded: true,
                storedSettings: STORED,
                formSettings: {},
            }),
        ).toEqual({});
    });
});

describe("credentialSettingsOverride — an unseeded form may only add", () => {
    it("stays silent when nothing was typed", () => {
        // The erasure that shipped: `{}` from a form that never saw the values
        // read as "delete them all".
        expect(
            credentialSettingsOverride({
                seeded: false,
                storedSettings: STORED,
                formSettings: {},
            }),
        ).toBeUndefined();
    });

    it("writes through what the user typed", () => {
        // The mirror defect: the user picks the provider inside the form, the
        // advanced fields appear, "Test" validates them — and dropping them is
        // the original "validated, toasted as saved, never sent" bug again.
        const out = credentialSettingsOverride({
            seeded: false,
            storedSettings: { baseURL: "https://x" },
            formSettings: PIN,
        });

        expect(out).toMatchObject(PIN);
    });

    it("carries through a stored field the form never showed", () => {
        // The whole reason this branch is additive: the user never saw the base
        // URL, so their silence about it is not a decision to remove it.
        const out = credentialSettingsOverride({
            seeded: false,
            storedSettings: { baseURL: "https://x" },
            formSettings: PIN,
        });

        expect(out).toEqual({ baseURL: "https://x", ...PIN });
    });

    it("lets a typed value win over the stored one", () => {
        const out = credentialSettingsOverride({
            seeded: false,
            storedSettings: { baseURL: "https://old" },
            formSettings: { baseURL: "https://new" },
        });

        expect(out).toEqual({ baseURL: "https://new" });
    });

    it("never sends a secret back — the browser only holds its mask", () => {
        // Re-sending "••••" would encrypt the mask and destroy the credential.
        // Blank is the contract for keeping it.
        const out = credentialSettingsOverride({
            seeded: false,
            storedSettings: STORED,
            formSettings: PIN,
        });

        expect(out).not.toHaveProperty("awsSecretAccessKey");
    });

    it("cannot tell a cleared field from an unseen one — which is why seeding exists", () => {
        // The honest limit of this branch, pinned so it is not mistaken for a
        // guarantee. A field the user typed and then CLEARED is absent from
        // formSettings, exactly like one they were never shown, so the stored
        // value is carried back.
        //
        // No rule over this input can separate the two: the information is not
        // here. The screen closes the gap instead — it seeds the fields once the
        // provider is known, after which the form is authoritative and clearing
        // is a real removal. This branch then covers only the render before that
        // seed lands.
        const out = credentialSettingsOverride({
            seeded: false,
            storedSettings: { baseURL: "https://old" },
            formSettings: PIN,
        });

        expect(out).toHaveProperty("baseURL", "https://old");
    });

    it("handles a credential that holds nothing at all", () => {
        expect(
            credentialSettingsOverride({
                seeded: false,
                storedSettings: undefined,
                formSettings: PIN,
            }),
        ).toEqual(PIN);
    });
});
