import type {
    BYOKConfig,
    BYOKConnectInput,
    BYOKCredential,
    BYOKModelConfig,
    BYOKRouting,
    ReasoningEffort,
} from "../_types";

/**
 * The config-level fields of a single model slot (everything on
 * BYOKModelConfig except its identity — `id`/`credentialId` are assigned by the
 * builder). Provider-scoped settings (baseURL, aws*, openrouter*) live on the
 * CREDENTIAL, not the model, so they are absent here.
 */
export type BYOKModelFields = {
    model: string;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxConcurrentRequests?: number;
    rpm?: number;
    tpm?: number;
    cooldownMs?: number;
};

/** The pasted-key half of a brand-new provider connection. */
export type NewCredentialInput = {
    provider: string;
    /** Plaintext key the user just pasted. Sent VERBATIM — this is the only
     *  place a real key enters the blob. */
    apiKey: string;
    settings?: Record<string, unknown>;
};

/**
 * The five write flows the Models tab produces, as a discriminated union so the
 * builder can't be called with an incoherent mix of fields.
 *
 * - connect             — first model for the org (new credential + model, sets default)
 * - add-new-provider    — add a model whose provider has no credential yet (new credential + model)
 * - add-existing-provider — add a model reusing a connected provider's credential (key deduped)
 * - rotate              — replace/keep a credential's key (+ optional settings), no model change
 * - edit-model          — replace a model's config fields, preserving its id/credentialId
 */
export type BuildV2Edit =
    | {
          kind: "connect";
          newCredential: NewCredentialInput;
          model: BYOKModelFields;
      }
    | {
          kind: "add-new-provider";
          newCredential: NewCredentialInput;
          model: BYOKModelFields;
      }
    | {
          kind: "add-existing-provider";
          credentialId: string;
          model: BYOKModelFields;
          /** Provider-scoped settings for the REUSED credential. Omit to keep
           *  the stored ones; pass an object (possibly empty) to REPLACE them. */
          credentialSettings?: Record<string, unknown>;
      }
    | {
          kind: "rotate";
          credentialId: string;
          /** New key, or "" to keep the stored ciphertext. NEVER the •••• mask. */
          apiKey: string;
          settings?: Record<string, unknown>;
      }
    | {
          kind: "edit-model";
          modelId: string;
          model: BYOKModelFields;
          /** Provider-scoped settings for the edited model's credential. Omit to
           *  keep the stored ones; pass an object (possibly empty) to REPLACE. */
          credentialSettings?: Record<string, unknown>;
      }
    | { kind: "routing"; routing: BYOKRouting };

/**
 * Split the {@link BYOKConnectInput} the connect/edit form emits into the v2
 * halves: the CREDENTIAL settings (provider-scoped:
 * baseURL, vertexLocation, aws*, openrouter*) and the per-MODEL fields. The key
 * itself stays on the form's `apiKey` and is passed to the builder separately.
 */
export const credentialSettingsFromConfig = (
    cfg: BYOKConnectInput,
): Record<string, unknown> | undefined => {
    const settings: Record<string, unknown> = {};
    if (cfg.baseURL) settings.baseURL = cfg.baseURL;
    if (cfg.vertexLocation) settings.vertexLocation = cfg.vertexLocation;
    if (cfg.awsRegion) settings.awsRegion = cfg.awsRegion;
    if (cfg.awsBearerToken) settings.awsBearerToken = cfg.awsBearerToken;
    if (cfg.awsAccessKeyId) settings.awsAccessKeyId = cfg.awsAccessKeyId;
    if (cfg.awsSecretAccessKey)
        settings.awsSecretAccessKey = cfg.awsSecretAccessKey;
    if (cfg.awsSessionToken) settings.awsSessionToken = cfg.awsSessionToken;
    if (cfg.openrouterProviderOrder)
        settings.openrouterProviderOrder = cfg.openrouterProviderOrder;
    if (typeof cfg.openrouterAllowFallbacks === "boolean")
        settings.openrouterAllowFallbacks = cfg.openrouterAllowFallbacks;
    return Object.keys(settings).length > 0 ? settings : undefined;
};

/** Lift the per-model config fields out of a legacy {@link BYOKConnectInput}. */
export const modelFieldsFromConfig = (
    cfg: BYOKConnectInput,
): BYOKModelFields => ({
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    reasoningConfigOverride: cfg.reasoningConfigOverride,
    temperature: cfg.temperature,
    maxInputTokens: cfg.maxInputTokens,
    maxOutputTokens: cfg.maxOutputTokens,
    maxConcurrentRequests: cfg.maxConcurrentRequests,
});

const defaultGenId = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `byok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Rebuild a credential for the outgoing blob with the encryptOrKeep contract:
 * emit `apiKey: ""` (blank-to-keep) for any credential whose key is UNCHANGED so
 * the server keeps its stored ciphertext, and NEVER echo the fetched `••••`
 * display mask back (RFC §13.1 / pitfall 3, T-04-08-01/02). A real replacement
 * key is passed through `apiKeyOverride`.
 */
const keepCredential = (
    cred: BYOKCredential,
    apiKeyOverride?: string,
    settingsOverride?: Record<string, unknown>,
): BYOKCredential => {
    const next: BYOKCredential = { ...cred };
    // Managed credentials never carry a key and are pass-through untouched.
    if (cred.managed) return next;

    const typed = apiKeyOverride?.trim();
    next.apiKey = typed ? apiKeyOverride! : "";
    if (settingsOverride) next.settings = settingsOverride;
    return next;
};

/** Assemble a model slot from its config fields + assigned identity. */
const buildModel = (
    id: string,
    credentialId: string,
    fields: BYOKModelFields,
): BYOKModelConfig => ({
    id,
    credentialId,
    model: fields.model,
    reasoningEffort: fields.reasoningEffort,
    reasoningConfigOverride: fields.reasoningConfigOverride,
    temperature: fields.temperature,
    maxInputTokens: fields.maxInputTokens,
    maxOutputTokens: fields.maxOutputTokens,
    maxConcurrentRequests: fields.maxConcurrentRequests,
    rpm: fields.rpm,
    tpm: fields.tpm,
    cooldownMs: fields.cooldownMs,
});

/**
 * True when `existing` carries no NON-managed model yet — i.e. the org is in
 * first-run and the next connected model should become the routing default.
 * A managed-only / empty / absent config counts as "no visible model".
 */
const hasNoVisibleModel = (
    existing: BYOKConfig | null | undefined,
): boolean => {
    if (!existing) return true;
    const nonManaged = new Set(
        (existing.credentials ?? []).filter((c) => !c.managed).map((c) => c.id),
    );
    return !(existing.models ?? []).some((m) => nonManaged.has(m.credentialId));
};

/**
 * Pure builder: turn a Models-tab write into a full v2 BYOKConfig blob for
 * `createOrUpdateOrganizationParameter(BYOK_CONFIG, blob)`.
 *
 * Secret hygiene is the whole point: every credential carried over from
 * `existing` is re-emitted with a BLANK apiKey (server keeps its ciphertext) and
 * the fetched `••••` mask is never sent as a key. Only a freshly pasted or
 * rotated key is emitted verbatim. Routing is preserved from `existing`;
 * routing.defaultModelId is set ONLY when creating the org's first visible model.
 */
export const buildByokBlob = (
    existing: BYOKConfig | null | undefined,
    edit: BuildV2Edit,
    genId: () => string = defaultGenId,
): BYOKConfig => {
    const routing: BYOKRouting = { ...(existing?.routing ?? {}) };
    const firstRun = hasNoVisibleModel(existing);

    switch (edit.kind) {
        case "connect":
        case "add-new-provider": {
            const credentials = (existing?.credentials ?? []).map((c) =>
                keepCredential(c),
            );
            const models = [...(existing?.models ?? [])];

            const credentialId = genId();
            credentials.push({
                id: credentialId,
                provider: edit.newCredential.provider,
                apiKey: edit.newCredential.apiKey,
                ...(edit.newCredential.settings
                    ? { settings: edit.newCredential.settings }
                    : {}),
            });

            const modelId = genId();
            models.push(buildModel(modelId, credentialId, edit.model));

            if (firstRun) routing.defaultModelId = modelId;

            return { version: 2, credentials, models, routing };
        }

        case "add-existing-provider": {
            const credentials = (existing?.credentials ?? []).map((c) =>
                c.id === edit.credentialId
                    ? keepCredential(c, undefined, edit.credentialSettings)
                    : keepCredential(c),
            );
            const models = [...(existing?.models ?? [])];

            const modelId = genId();
            models.push(buildModel(modelId, edit.credentialId, edit.model));

            if (firstRun) routing.defaultModelId = modelId;

            return { version: 2, credentials, models, routing };
        }

        case "rotate": {
            const credentials = (existing?.credentials ?? []).map((c) =>
                c.id === edit.credentialId
                    ? keepCredential(c, edit.apiKey, edit.settings)
                    : keepCredential(c),
            );
            const models = [...(existing?.models ?? [])];
            return { version: 2, credentials, models, routing };
        }

        case "edit-model": {
            // Provider-scoped settings (baseURL, openrouter*, …) live on the
            // CREDENTIAL, but the form that edits them is this model's form. So
            // an edit-model save has to be able to write them through to the
            // model's credential — without that, the fields render, validate and
            // report success while the value is dropped client-side, which is
            // exactly how a pinned OpenRouter provider order could never be
            // changed once its credential existed.
            const edited = (existing?.models ?? []).find(
                (m) => m.id === edit.modelId,
            );
            const credentials = (existing?.credentials ?? []).map((c) =>
                edited && c.id === edited.credentialId
                    ? keepCredential(c, undefined, edit.credentialSettings)
                    : keepCredential(c),
            );
            const models = (existing?.models ?? []).map((m) =>
                m.id === edit.modelId
                    ? buildModel(m.id, m.credentialId, edit.model)
                    : m,
            );
            return { version: 2, credentials, models, routing };
        }

        case "routing": {
            // Routing-only save (04-10 Routing tab): credentials + models are
            // preserved verbatim (blank-key keepCredential ⇒ server keeps each
            // stored ciphertext, never echoing the •••• mask), and `routing` is
            // replaced wholesale — the Routing tab constructs the COMPLETE
            // routing object each save.
            const credentials = (existing?.credentials ?? []).map((c) =>
                keepCredential(c),
            );
            const models = [...(existing?.models ?? [])];
            return { version: 2, credentials, models, routing: edit.routing };
        }
    }
};
