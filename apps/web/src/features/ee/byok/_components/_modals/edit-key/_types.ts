import { z } from "zod";

const baseFields = {
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    baseURL: z.url().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    maxInputTokens: z.number().int().min(0).nullable().optional(),
    maxConcurrentRequests: z.number().int().min(0).nullable().optional(),
    maxOutputTokens: z.number().int().min(0).nullable().optional(),
    reasoningEffort: z
        .enum(["none", "low", "medium", "high", "custom"])
        .nullable()
        .optional(),
    reasoningConfigOverride: z.string().nullable().optional(),
    openrouterProviderOrder: z.array(z.string()).nullable().optional(),
    openrouterAllowFallbacks: z.boolean().nullable().optional(),
    vertexLocation: z.string().trim().nullable().optional(),
    awsBearerToken: z.string().trim().nullable().optional(),
    awsAccessKeyId: z.string().trim().nullable().optional(),
    awsSecretAccessKey: z.string().trim().nullable().optional(),
    awsRegion: z.string().trim().nullable().optional(),
    awsSessionToken: z.string().trim().nullable().optional(),
};

/**
 * Create schema: requires credentials for the active provider.
 * - amazon_bedrock: awsAccessKeyId + awsSecretAccessKey required
 * - everything else: apiKey required
 */
export const createKeySchema = z
    .object({
        ...baseFields,
        apiKey: z.string().trim().optional().default(""),
    })
    .superRefine((data, ctx) => {
        if (data.provider === "amazon_bedrock") {
            const hasBearer = !!data.awsBearerToken?.trim();
            const hasAccessKey = !!data.awsAccessKeyId?.trim();
            const hasSecret = !!data.awsSecretAccessKey?.trim();
            const hasAnyIam = hasAccessKey || hasSecret;

            // Happy path: bearer token set → done.
            if (hasBearer) return;

            // User is clearly trying IAM (touched at least one field).
            // Surface field-specific errors so they land next to the
            // missing input, not on an unrelated bearer-token field.
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
                return;
            }

            // Nothing filled in at all — nudge toward the recommended path.
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["awsBearerToken"],
                message:
                    "Paste a Bedrock API key, or expand Advanced to use IAM user credentials.",
            });
            return;
        }
        if (!data.apiKey?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["apiKey"],
                message: "API key is required",
            });
        }
    });

export const editKeySchema = z.object({
    ...baseFields,
    apiKey: z.string().trim().optional().default(""),
});

export type EditKeyForm = z.infer<typeof editKeySchema>;
