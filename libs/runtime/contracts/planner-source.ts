import { z } from 'zod';
import { parseStrictJson } from '@libs/runtime/protocol/strict-json';

export const PLANNER_SOURCE_PATH = 'internal/runtime/planner-source';
export const PLANNER_SOURCE_LIMITS = {
    bytes: 300_000,
    readBytes: 256 * 1024,
    listEntries: 400,
    cacheEntries: 32,
    treePaths: 100_000,
} as const;
const base = {
    v: z.literal(1),
    scope: z.strictObject({
        runId: z.uuid(),
        attempt: z.number().int().positive(),
    }),
};
const target = { side: z.enum(['base', 'head']), path: z.string().max(1024) };
export const PlannerSourceRequestSchema = z.discriminatedUnion('op', [
    z.strictObject({ ...base, op: z.literal('context') }),
    z.strictObject({ ...base, ...target, op: z.literal('list') }),
    z.strictObject({ ...base, ...target, op: z.literal('exists') }),
    z.strictObject({
        ...base,
        ...target,
        op: z.literal('read'),
        maxBytes: z.number().int().min(1).max(PLANNER_SOURCE_LIMITS.readBytes),
    }),
]);
export type PlannerSourceRequest = z.infer<typeof PlannerSourceRequestSchema>;
export const PlannerSourceResponseSchema = z.union([
    z.strictObject({
        repositoryName: z.string().min(1).max(1024),
        baseSha: z.string().regex(/^[a-f0-9]{40}$/),
        headSha: z.string().regex(/^[a-f0-9]{40}$/),
        changedPaths: z.array(z.string().max(1024)).max(501),
    }),
    z.strictObject({
        entries: z
            .array(z.string().max(1024))
            .max(PLANNER_SOURCE_LIMITS.listEntries),
    }),
    z.strictObject({
        text: z.string().max(PLANNER_SOURCE_LIMITS.bytes).nullable(),
    }),
    z.strictObject({ exists: z.boolean() }),
]);
export type PlannerSourceResponse = z.infer<typeof PlannerSourceResponseSchema>;
export function parsePlannerSourceResponse(
    input: unknown,
): PlannerSourceResponse {
    const value =
        typeof input === 'string' ? parseStrictJson(input, 32) : input;
    if (
        Buffer.byteLength(JSON.stringify(value), 'utf8') >
        PLANNER_SOURCE_LIMITS.bytes
    )
        throw Error('source response too large');
    return PlannerSourceResponseSchema.parse(value);
}
