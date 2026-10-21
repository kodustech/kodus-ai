import { z } from "zod";

import { refineProviderCredentials } from "./credential-config";

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
        // A provider with bespoke credential rules (registered in
        // credential-config) validates itself; if it handled things, skip the
        // default. Everything else just needs an API key.
        if (refineProviderCredentials(data, ctx)) return;
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
