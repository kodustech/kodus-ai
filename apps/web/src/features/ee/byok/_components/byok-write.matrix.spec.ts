import type { BYOKConfig } from "../_types";
import { buildByokBlob, type BuildV2Edit } from "./byok-write";

/**
 * Every write path crossed with every state of the thing it writes.
 *
 * This exists because testing the cases I had in mind is what let a fix for
 * "credential settings never save" grow a path where they get ERASED instead.
 * The screens were checked, the builder was checked, and the combination that
 * was never checked — an unseeded form reaching an existing credential — is the
 * one that shipped broken. Enumerating the product is the only way that stops
 * being a matter of remembering.
 *
 * The dimensions:
 *
 *   - which WRITE it is: the five kinds callers emit, plus `connect`
 *   - what the credential HOLDS: settings, none, or a managed credential that
 *     owns no key at all
 *   - what the write SAYS about settings: nothing, an empty object, or values
 *
 * And the invariants every cell is judged against:
 *
 *   1. absent override keeps what is stored — silence is not an instruction
 *   2. an empty object clears, because a user must be able to unpin
 *   3. values replace, since the server replaces rather than merges
 *   4. a credential the write is not about is never touched
 *   5. a non-managed credential is re-emitted with a BLANK key, never the mask
 *   6. a managed credential keeps no key and is passed through whole
 */

const PIN = { openrouterProviderOrder: ["moonshot"] };
const OTHER = { baseURL: "https://other" };

const config = (mainSettings?: Record<string, unknown>): BYOKConfig =>
    ({
        version: 2,
        credentials: [
            {
                id: "cred-main",
                provider: "open_router",
                apiKey: "•••• stored",
                ...(mainSettings ? { settings: mainSettings } : {}),
            },
            {
                id: "cred-other",
                provider: "openai",
                apiKey: "cipher2",
                settings: OTHER,
            },
            { id: "cred-managed", provider: "openai", managed: true },
        ],
        models: [
            { id: "model-main", credentialId: "cred-main", model: "a" },
            { id: "model-other", credentialId: "cred-other", model: "b" },
        ],
        routing: { defaultModelId: "model-main" },
    }) as BYOKConfig;

const credOf = (blob: BYOKConfig, id: string) =>
    blob.credentials.find((c) => c.id === id)!;

/** The writes that can carry a settings override for `cred-main`. */
const withOverride = (
    settings?: Record<string, unknown>,
): Array<[string, BuildV2Edit]> => [
    [
        "add-existing-provider",
        {
            kind: "add-existing-provider",
            credentialId: "cred-main",
            model: { model: "c" },
            ...(settings === undefined ? {} : { credentialSettings: settings }),
        },
    ],
    [
        "edit-model",
        {
            kind: "edit-model",
            modelId: "model-main",
            model: { model: "a" },
            ...(settings === undefined ? {} : { credentialSettings: settings }),
        },
    ],
    [
        "rotate",
        {
            kind: "rotate",
            credentialId: "cred-main",
            apiKey: "",
            ...(settings === undefined ? {} : { settings }),
        },
    ],
];

describe("byok-write — every write against every state", () => {
    describe("invariant 1: silence keeps what is stored", () => {
        it.each(withOverride(undefined))("%s", (_label, edit) => {
            expect(
                credOf(buildByokBlob(config(PIN), edit), "cred-main").settings,
            ).toEqual(PIN);
        });

        it.each(withOverride(undefined))(
            "%s — and adds nothing when there were none",
            (_label, edit) => {
                expect(
                    credOf(buildByokBlob(config(), edit), "cred-main").settings,
                ).toBeUndefined();
            },
        );
    });

    describe("invariant 2: an empty object clears", () => {
        it.each(withOverride({}))("%s", (_label, edit) => {
            expect(
                credOf(buildByokBlob(config(PIN), edit), "cred-main").settings,
            ).toEqual({});
        });
    });

    describe("invariant 3: values replace, they do not merge", () => {
        it.each(withOverride({ openrouterAllowFallbacks: false }))(
            "%s",
            (_label, edit) => {
                // The pin is GONE, not merged with the new value — mirroring the
                // server, which replaces the object it receives.
                expect(
                    credOf(buildByokBlob(config(PIN), edit), "cred-main")
                        .settings,
                ).toEqual({ openrouterAllowFallbacks: false });
            },
        );
    });

    describe("invariant 4: a write never touches a credential it is not about", () => {
        const everyWrite: Array<[string, BuildV2Edit]> = [
            ...withOverride({ replaced: true }),
            [
                "add-new-provider",
                {
                    kind: "add-new-provider",
                    newCredential: { provider: "anthropic", apiKey: "new" },
                    model: { model: "d" },
                },
            ],
            [
                "connect",
                {
                    kind: "connect",
                    newCredential: { provider: "anthropic", apiKey: "new" },
                    model: { model: "d" },
                },
            ],
            [
                "routing",
                { kind: "routing", routing: { defaultModelId: "model-other" } },
            ],
        ];

        it.each(everyWrite)("%s leaves cred-other intact", (_label, edit) => {
            expect(
                credOf(buildByokBlob(config(PIN), edit), "cred-other").settings,
            ).toEqual(OTHER);
        });

        it.each(everyWrite)(
            "%s leaves the managed credential alone",
            (_l, edit) => {
                // Managed credentials carry no key of their own; emitting a blank
                // one would invent a field the runtime reads as a broken BYOK key.
                const managed = credOf(
                    buildByokBlob(config(PIN), edit),
                    "cred-managed",
                );

                expect(managed.managed).toBe(true);
                expect(managed.apiKey).toBeUndefined();
            },
        );
    });

    describe("invariant 5: a stored key is kept by blanking, never echoed", () => {
        const everyWrite: Array<[string, BuildV2Edit]> = [
            ...withOverride(PIN),
            [
                "routing",
                { kind: "routing", routing: { defaultModelId: "model-other" } },
            ],
        ];

        it.each(everyWrite)("%s blanks cred-main's key", (_label, edit) => {
            // The fetched value is the `••••` display mask. Sending it back
            // would encrypt the mask and destroy the credential.
            expect(
                credOf(buildByokBlob(config(PIN), edit), "cred-main").apiKey,
            ).toBe("");
        });

        it("a rotate with a typed key sends that key verbatim", () => {
            const blob = buildByokBlob(config(PIN), {
                kind: "rotate",
                credentialId: "cred-main",
                apiKey: "sk-brand-new",
            });

            expect(credOf(blob, "cred-main").apiKey).toBe("sk-brand-new");
        });
    });

    describe("models and routing survive a settings write", () => {
        it.each(withOverride(PIN))("%s keeps every model", (_label, edit) => {
            const blob = buildByokBlob(config(PIN), edit);

            expect(blob.models.map((m) => m.id)).toEqual(
                expect.arrayContaining(["model-main", "model-other"]),
            );
        });

        it.each(withOverride(PIN))("%s keeps routing", (_label, edit) => {
            expect(buildByokBlob(config(PIN), edit).routing).toEqual({
                defaultModelId: "model-main",
            });
        });
    });
});
