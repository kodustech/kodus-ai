import type { BYOKConfigV2 } from "../_types";
import { buildV2Blob } from "./byok-v2-write";

/**
 * The builder is pure and its ids must be deterministic under test — inject a
 * counter-based generator so we can assert exact ids without pulling in a real
 * uuid. Production defaults to crypto.randomUUID().
 */
const makeGenId = () => {
    let n = 0;
    return () => `id-${++n}`;
};

const MASK = "sk-1•••••fabc"; // the shape maskKey() produces for a stored key

describe("buildV2Blob — v2 write builder (blank-key keep rule)", () => {
    describe("connect / first model (no existing config)", () => {
        it("creates one credential + one model and points routing.defaultModelId at it", () => {
            const blob = buildV2Blob(
                null,
                {
                    kind: "connect",
                    newCredential: {
                        provider: "openai",
                        apiKey: "sk-real-openai-key",
                        settings: { baseURL: "https://api.openai.com/v1" },
                    },
                    model: { model: "gpt-5-high", reasoningEffort: "high" },
                },
                makeGenId(),
            );

            expect(blob.version).toBe(2);
            expect(blob.credentials).toHaveLength(1);
            expect(blob.credentials[0]).toMatchObject({
                id: "id-1",
                provider: "openai",
                apiKey: "sk-real-openai-key",
                settings: { baseURL: "https://api.openai.com/v1" },
            });
            expect(blob.models).toHaveLength(1);
            expect(blob.models[0]).toMatchObject({
                id: "id-2",
                credentialId: "id-1",
                model: "gpt-5-high",
                reasoningEffort: "high",
            });
            // first-run default points at the just-created model
            expect(blob.routing?.defaultModelId).toBe("id-2");
        });

        it("sets the first-run default even when the existing config is managed-only (no visible model)", () => {
            const existing: BYOKConfigV2 = {
                version: 2,
                credentials: [{ id: "mgd", provider: "openai", managed: true }],
                models: [],
                routing: {},
            };

            const blob = buildV2Blob(
                existing,
                {
                    kind: "connect",
                    newCredential: {
                        provider: "anthropic",
                        apiKey: "sk-ant-real",
                    },
                    model: { model: "claude-opus" },
                },
                makeGenId(),
            );

            const newModel = blob.models.find((m) => m.model === "claude-opus");
            expect(newModel).toBeDefined();
            expect(blob.routing?.defaultModelId).toBe(newModel!.id);
        });
    });

    describe("add-model to an ALREADY-connected provider (reuse credential)", () => {
        const existing: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: "cred-openai", provider: "openai", apiKey: MASK },
            ],
            models: [
                { id: "m-1", credentialId: "cred-openai", model: "gpt-5-high" },
            ],
            routing: { defaultModelId: "m-1" },
        };

        it("appends only a models[] entry with the existing credentialId; credentials list is unchanged in shape", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "add-existing-provider",
                    credentialId: "cred-openai",
                    model: { model: "gpt-5-mini", temperature: 0.2 },
                },
                makeGenId(),
            );

            expect(blob.credentials).toHaveLength(1);
            expect(blob.credentials[0].id).toBe("cred-openai");
            expect(blob.models).toHaveLength(2);
            const added = blob.models.find((m) => m.model === "gpt-5-mini");
            expect(added).toMatchObject({
                credentialId: "cred-openai",
                model: "gpt-5-mini",
                temperature: 0.2,
            });
        });

        it("does NOT change routing.defaultModelId when a model already exists", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "add-existing-provider",
                    credentialId: "cred-openai",
                    model: { model: "gpt-5-mini" },
                },
                makeGenId(),
            );
            expect(blob.routing?.defaultModelId).toBe("m-1");
        });

        it("NEVER re-emits the masked apiKey for the reused credential — it is blanked to keep the stored ciphertext", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "add-existing-provider",
                    credentialId: "cred-openai",
                    model: { model: "gpt-5-mini" },
                },
                makeGenId(),
            );
            expect(blob.credentials[0].apiKey).toBe("");
            expect(blob.credentials[0].apiKey).not.toContain("•");
        });
    });

    describe("add-model for a NEW provider (new credential + key step)", () => {
        const existing: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: "cred-openai", provider: "openai", apiKey: MASK },
            ],
            models: [
                { id: "m-1", credentialId: "cred-openai", model: "gpt-5-high" },
            ],
            routing: { defaultModelId: "m-1" },
        };

        it("appends a new credential (with the pasted key) + a model referencing it, and blanks pre-existing credentials", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "add-new-provider",
                    newCredential: {
                        provider: "anthropic",
                        apiKey: "sk-ant-fresh",
                    },
                    model: { model: "claude-opus" },
                },
                makeGenId(),
            );

            expect(blob.credentials).toHaveLength(2);
            const oldCred = blob.credentials.find((c) => c.id === "cred-openai");
            const newCred = blob.credentials.find(
                (c) => c.provider === "anthropic",
            );
            expect(oldCred?.apiKey).toBe(""); // blanked, never the mask
            expect(newCred?.apiKey).toBe("sk-ant-fresh"); // the real pasted key
            const added = blob.models.find((m) => m.model === "claude-opus");
            expect(added?.credentialId).toBe(newCred?.id);
            // still not first-run → default unchanged
            expect(blob.routing?.defaultModelId).toBe("m-1");
        });
    });

    describe("rotate key (blank keeps ciphertext, real value replaces it)", () => {
        const existing: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: "cred-openai", provider: "openai", apiKey: MASK },
            ],
            models: [
                { id: "m-1", credentialId: "cred-openai", model: "gpt-5-high" },
            ],
            routing: { defaultModelId: "m-1" },
        };

        it("sends apiKey: '' (NOT the •••• mask) when the key is unchanged", () => {
            const blob = buildV2Blob(
                existing,
                { kind: "rotate", credentialId: "cred-openai", apiKey: "" },
                makeGenId(),
            );
            const cred = blob.credentials.find((c) => c.id === "cred-openai");
            expect(cred?.apiKey).toBe("");
            expect(cred?.apiKey).not.toContain("•");
        });

        it("sends the new key verbatim when the user typed one", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "rotate",
                    credentialId: "cred-openai",
                    apiKey: "sk-rotated-new",
                },
                makeGenId(),
            );
            const cred = blob.credentials.find((c) => c.id === "cred-openai");
            expect(cred?.apiKey).toBe("sk-rotated-new");
        });

        it("carries new provider settings (e.g. baseURL) when supplied on rotate", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "rotate",
                    credentialId: "cred-openai",
                    apiKey: "",
                    settings: { baseURL: "https://proxy.internal/v1" },
                },
                makeGenId(),
            );
            const cred = blob.credentials.find((c) => c.id === "cred-openai");
            expect(cred?.settings).toEqual({
                baseURL: "https://proxy.internal/v1",
            });
        });

        it("does not add or remove models on rotate", () => {
            const blob = buildV2Blob(
                existing,
                { kind: "rotate", credentialId: "cred-openai", apiKey: "" },
                makeGenId(),
            );
            expect(blob.models).toHaveLength(1);
            expect(blob.models[0].id).toBe("m-1");
        });
    });

    describe("edit-model (preserve id, replace fields)", () => {
        const existing: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: "cred-openai", provider: "openai", apiKey: MASK },
            ],
            models: [
                {
                    id: "m-1",
                    credentialId: "cred-openai",
                    model: "gpt-5-high",
                    temperature: 0.2,
                },
            ],
            routing: { defaultModelId: "m-1" },
        };

        it("preserves the existing model id and credentialId while replacing its config fields", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "edit-model",
                    modelId: "m-1",
                    model: {
                        model: "gpt-5-high",
                        temperature: 0.7,
                        reasoningEffort: "medium",
                        rpm: 60,
                    },
                },
                makeGenId(),
            );
            expect(blob.models).toHaveLength(1);
            expect(blob.models[0]).toMatchObject({
                id: "m-1",
                credentialId: "cred-openai",
                model: "gpt-5-high",
                temperature: 0.7,
                reasoningEffort: "medium",
                rpm: 60,
            });
        });

        it("blanks every existing credential key on edit-model (mask never emitted)", () => {
            const blob = buildV2Blob(
                existing,
                {
                    kind: "edit-model",
                    modelId: "m-1",
                    model: { model: "gpt-5-high", temperature: 0.7 },
                },
                makeGenId(),
            );
            expect(blob.credentials[0].apiKey).toBe("");
        });
    });

    describe("secret hygiene invariant (across every flow)", () => {
        const existing: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: "cred-openai", provider: "openai", apiKey: MASK },
                { id: "cred-anthropic", provider: "anthropic", apiKey: MASK },
            ],
            models: [
                { id: "m-1", credentialId: "cred-openai", model: "gpt-5-high" },
                {
                    id: "m-2",
                    credentialId: "cred-anthropic",
                    model: "claude-opus",
                },
            ],
            routing: { defaultModelId: "m-1" },
        };

        const flows = [
            {
                name: "add-existing-provider",
                edit: {
                    kind: "add-existing-provider" as const,
                    credentialId: "cred-openai",
                    model: { model: "gpt-5-mini" },
                },
            },
            {
                name: "add-new-provider",
                edit: {
                    kind: "add-new-provider" as const,
                    newCredential: { provider: "novita", apiKey: "sk-novita" },
                    model: { model: "some-model" },
                },
            },
            {
                name: "rotate",
                edit: {
                    kind: "rotate" as const,
                    credentialId: "cred-openai",
                    apiKey: "",
                },
            },
            {
                name: "edit-model",
                edit: {
                    kind: "edit-model" as const,
                    modelId: "m-1",
                    model: { model: "gpt-5-high", temperature: 0.5 },
                },
            },
        ];

        it.each(flows)(
            "never emits a masked ('•') string as any credential apiKey — $name",
            ({ edit }) => {
                const blob = buildV2Blob(existing, edit, makeGenId());
                for (const cred of blob.credentials) {
                    expect(cred.apiKey ?? "").not.toContain("•");
                }
            },
        );
    });
});
