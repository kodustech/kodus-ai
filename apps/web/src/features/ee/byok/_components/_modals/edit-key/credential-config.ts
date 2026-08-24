import { z } from "zod";

import type { EditKeyForm } from "./_types";

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
    google_vertex: ["vertexLocation"],
    amazon_bedrock: [
        "awsBearerToken",
        "awsAccessKeyId",
        "awsSecretAccessKey",
        "awsRegion",
        "awsSessionToken",
    ],
    open_router: ["openrouterProviderOrder", "openrouterAllowFallbacks"],
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
    (CREDS_PRESENT[data.provider ?? ""] ?? ((d) => !!d.apiKey?.trim()))(data);

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
 * A provider's create-time credential validator. Returns `true` when it fully
 * handled validation (the caller then SKIPS the default "apiKey required"
 * check); `false` to defer to the default.
 */
type CreateRefiner = (
    data: EditKeyForm,
    ctx: z.RefinementCtx,
) => boolean;

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
                path: ["awsAccessKeyId"],
                message: "Access Key ID is required",
            });
        }
        if (!hasSecret) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["awsSecretAccessKey"],
                message: "Secret Access Key is required",
            });
        }
        return true;
    }

    // Nothing filled in at all — nudge toward the recommended path.
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awsBearerToken"],
        message:
            "Paste a Bedrock API key, or expand Advanced to use IAM user credentials.",
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
