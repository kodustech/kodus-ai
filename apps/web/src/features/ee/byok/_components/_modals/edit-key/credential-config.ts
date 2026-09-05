import { z } from 'zod';

import type { EditKeyForm } from './_types';

/**
 * Per-provider credential CONFIG — the non-UI half of a provider's web wiring
 * (the UI half is the `credential-forms` registry). PURE (no React), so both the
 * form's zod schema (`_types`) and the submit handler can import it without
 * pulling components. A provider that needs extra credential fields or bespoke
 * required-field validation adds itself HERE, in ONE place, instead of scattering
 * `provider === "x"` checks across the schema and the submit builder.
 */

/**
 * Extra (non-core) form fields each provider owns, beyond `apiKey`/`baseURL`.
 * The submit builder includes one of these ONLY for the active provider, so a
 * value left in RHF state after switching providers never leaks into another
 * provider's credential.
 */
export const PROVIDER_SETTING_KEYS = {
    google_vertex: ['vertexLocation'],
    amazon_bedrock: [
        'awsBearerToken',
        'awsAccessKeyId',
        'awsSecretAccessKey',
        'awsRegion',
        'awsSessionToken',
    ],
    open_router: ['openrouterProviderOrder', 'openrouterAllowFallbacks'],
} satisfies Record<string, Array<keyof EditKeyForm>>;

/**
 * "Does the form carry enough credentials to Test/save?" — provider-specific
 * because the credential SHAPE differs (Bedrock: a bearer token OR a full IAM
 * access-key+secret pair; everyone else: a single API key). Registered per
 * provider so the presence rule lives with the rest of that provider's wiring.
 */
type CredsPresent = (data: Partial<EditKeyForm>) => boolean;

const CREDS_PRESENT: Record<string, CredsPresent> = {
    amazon_bedrock: (d) =>
        !!(
            d.awsBearerToken?.trim() ||
            (d.awsAccessKeyId?.trim() && d.awsSecretAccessKey?.trim())
        ),
};

/** Whether the entered credentials are complete enough to probe/save. */
export const providerHasCredentials = (data: Partial<EditKeyForm>): boolean =>
    (CREDS_PRESENT[data.provider ?? ''] ?? ((d) => !!d.apiKey?.trim()))(data);

/** True when `field` is a credential/setting field the given provider owns. */
export const providerOwnsField = (
    provider: string | undefined,
    field: keyof EditKeyForm,
): boolean =>
    !!provider &&
    (PROVIDER_SETTING_KEYS as Record<string, Array<keyof EditKeyForm>>)[
        provider
    ]?.includes(field) === true;

/**
 * Setting fields that hold a SECRET. The read path masks or strips these before
 * the blob reaches the browser, so a form must never seed them from the stored
 * credential: a BLANK secret is what tells the server to keep its ciphertext,
 * and seeding the `••••` mask back would send the mask as a value. Mirrors
 * `BYOK_SECRET_SETTINGS` in `libs/llm/byok-config.ts`, which the web bundle
 * cannot import a value from.
 */
const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
    'awsBearerToken',
    'awsAccessKeyId',
    'awsSecretAccessKey',
    'awsSessionToken',
]);

/**
 * Seed a form's provider-owned setting fields from the STORED credential.
 *
 * The server REPLACES a credential's `settings` wholesale on save, carrying over
 * only the encrypted aws* fields. So a screen that does not seed a field cannot
 * re-send it, and a field that is not re-sent is DELETED — silently, by a save
 * the user made about something else entirely.
 *
 * The "Edit provider" panel neither showed nor seeded the OpenRouter pin, so it
 * rebuilt `settings` without it. That is latent rather than observed: the panel
 * omits the object entirely when its form yields nothing, and the builder then
 * keeps what is stored — so the erasure only fires on a credential that ALSO
 * carries a field the panel does render (a baseURL). Production shows no
 * credential in that state, and none with a stripped-down settings object.
 *
 * Driving the seed off `PROVIDER_SETTING_KEYS` is what stops it recurring: a
 * provider registers its fields ONCE and every screen that writes a credential
 * carries them, instead of each screen hand-listing the fields it happens to
 * know about.
 */
export const providerSettingDefaults = (
    provider: string | undefined,
    settings: Record<string, unknown> | undefined,
): Partial<EditKeyForm> => {
    const seeded: Record<string, unknown> = {};
    if (!provider || !settings) return seeded as Partial<EditKeyForm>;

    const owned =
        (PROVIDER_SETTING_KEYS as Record<string, Array<keyof EditKeyForm>>)[
            provider
        ] ?? [];
    for (const key of owned) {
        if (SECRET_SETTING_KEYS.has(key)) continue;
        const value = settings[key];
        if (value !== undefined) seeded[key] = value;
    }
    return seeded as Partial<EditKeyForm>;
};

/**
 * Every setting key some credential form is authoritative for: the shared
 * `baseURL` plus every provider's registered fields.
 */
const FORM_OWNED_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    'baseURL',
    ...Object.values(
        PROVIDER_SETTING_KEYS as Record<string, readonly string[]>,
    ).flat(),
]);

/**
 * The stored settings NO credential form owns, carried through a save untouched.
 *
 * The server replaces a credential's `settings` with what the client sends, so
 * whatever the form does not re-send is deleted. The forms are authoritative for
 * the keys they render — clearing `baseURL` must really clear it — but they must
 * not delete a key they have never heard of: a setting written by a newer API,
 * by another screen, or by a provider field this build does not render yet.
 *
 * Without this, "the screen that does not know a field is the screen that
 * erases it" stays true for every field added from here on.
 */
export const unownedStoredSettings = (
    settings: Record<string, unknown> | undefined,
): Record<string, unknown> => {
    const carried: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings ?? {})) {
        if (!FORM_OWNED_SETTING_KEYS.has(key)) carried[key] = value;
    }
    return carried;
};

/**
 * A provider's create-time credential validator. Returns `true` when it fully
 * handled validation (the caller then SKIPS the default "apiKey required"
 * check); `false` to defer to the default.
 */
type CreateRefiner = (data: EditKeyForm, ctx: z.RefinementCtx) => boolean;

const refineBedrock: CreateRefiner = (data, ctx) => {
    const hasBearer = !!data.awsBearerToken?.trim();
    const hasAccessKey = !!data.awsAccessKeyId?.trim();
    const hasSecret = !!data.awsSecretAccessKey?.trim();
    const hasAnyIam = hasAccessKey || hasSecret;

    // Happy path: bearer token set → done.
    if (hasBearer) return true;

    // User is clearly trying IAM (touched at least one field). Surface
    // field-specific errors so they land next to the missing input.
    if (hasAnyIam) {
        if (!hasAccessKey) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['awsAccessKeyId'],
                message: 'Access Key ID is required',
            });
        }
        if (!hasSecret) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['awsSecretAccessKey'],
                message: 'Secret Access Key is required',
            });
        }
        return true;
    }

    // Nothing filled in at all — nudge toward the recommended path.
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['awsBearerToken'],
        message:
            'Paste a Bedrock API key, or expand Advanced to use IAM user credentials.',
    });
    return true;
};

const CREATE_REFINERS: Record<string, CreateRefiner> = {
    amazon_bedrock: refineBedrock,
};

/**
 * Run the active provider's bespoke credential validation, if any. Returns
 * `true` when handled (skip the default apiKey-required check).
 */
export const refineProviderCredentials = (
    data: EditKeyForm,
    ctx: z.RefinementCtx,
): boolean => CREATE_REFINERS[data.provider]?.(data, ctx) ?? false;
