import { z } from 'zod';

import {
    SubmitFindingsSchema,
    VerifyFindingSchema,
} from '@libs/runtime/contracts/external-findings';

export const A2A_MAX_BODY_BYTES = 256 * 1024;
const emptyMetadata = z
    .record(z.string(), z.unknown())
    .refine((v) => !Object.keys(v).length)
    .optional();
const emptyString = z.literal('').optional();
const emptyList = z.array(z.string()).max(0).optional();
const dataPart = z.strictObject({
    data: z.record(z.string(), z.unknown()),
    mediaType: z.literal('application/json').or(z.literal('')).optional(),
    filename: emptyString,
    metadata: emptyMetadata,
});
const message = z.strictObject({
    messageId: z.string().min(1).max(128),
    role: z.literal('ROLE_USER'),
    contextId: emptyString,
    taskId: emptyString,
    parts: z.array(dataPart).length(1),
    metadata: emptyMetadata,
    extensions: emptyList,
    referenceTaskIds: emptyList,
});
const configuration = z.strictObject({
    returnImmediately: z.boolean().optional(),
    historyLength: z.number().int().min(0).max(50).optional(),
    acceptedOutputModes: z
        .array(z.literal('application/json'))
        .max(1)
        .optional(),
});
const send = z.strictObject({
    message,
    configuration: configuration.optional(),
    metadata: emptyMetadata,
    tenant: emptyString,
});
const task = z.strictObject({
    id: z.uuid(),
    historyLength: z.number().int().min(0).max(50).optional(),
    tenant: emptyString,
});
const envelope = z.strictObject({
    jsonrpc: z.literal('2.0'),
    id: z.string().min(1).max(128).or(z.number().int().safe()),
    method: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()),
});

/** Bound work before schema/SDK codecs can discard ambiguous fields or walk huge structures. */
export function isBoundedA2ABody(body: unknown): boolean {
    const pending: Array<[unknown, number]> = [[body, 0]];
    let nodes = 0;
    while (pending.length) {
        const [value, depth] = pending.pop()!;
        if (++nodes > 8192 || depth > 32) return false;
        if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key))
                    return false;
                pending.push([child, depth + 1]);
            }
        }
    }
    try {
        return Buffer.byteLength(JSON.stringify(body)) <= A2A_MAX_BODY_BYTES;
    } catch {
        return false;
    }
}

export function checkedA2AWire(body: unknown) {
    if (!isBoundedA2ABody(body)) return { ok: false as const };
    const parsed = envelope.safeParse(body);
    if (!parsed.success) return { ok: false as const };
    const rpc = parsed.data;
    if (rpc.method === 'SendMessage') {
        const config = rpc.params.configuration;
        if (
            config &&
            typeof config === 'object' &&
            'taskPushNotificationConfig' in config
        )
            return { ok: false as const, rpc, unsupportedPush: true as const };
        const params = send.safeParse(rpc.params);
        if (!params.success) return { ok: false as const, rpc };
        const data = params.data.message.parts[0].data;
        const { operation, ...input } = data;
        if (operation !== 'submit_findings' && operation !== 'verify_finding')
            return { ok: false as const, rpc };
        if (
            operation === 'verify_finding' &&
            params.data.configuration?.returnImmediately !== true
        )
            return { ok: false as const, rpc };
        const business =
            operation === 'submit_findings'
                ? SubmitFindingsSchema.safeParse(input)
                : VerifyFindingSchema.safeParse(input);
        if (!business.success) return { ok: false as const, rpc };
        return { ok: true as const, rpc, operation, input: business.data };
    }
    if (
        (rpc.method === 'GetTask' || rpc.method === 'CancelTask') &&
        !task.safeParse(rpc.params).success
    )
        return { ok: false as const, rpc };
    return { ok: true as const, rpc };
}
