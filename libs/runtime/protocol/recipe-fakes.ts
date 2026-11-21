import { z } from 'zod';

const envKey = z
    .string()
    .max(128)
    .refine(
        (key) => !['__proto__', 'constructor', 'prototype'].includes(key),
        'reserved environment name',
    );
const envValue = z
    .string()
    .max(2048)
    .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 2048,
        'at most 2048 UTF-8 bytes',
    );
const env = z
    .record(envKey, envValue)
    .refine(
        (v) => Object.keys(v).length <= 32,
        'at most 32 environment entries',
    );
const descriptor = (alias: string, pinned: RegExp) =>
    z.union([
        z.literal(true),
        z.strictObject({
            image: z.union([z.literal(alias), z.string().regex(pinned)]),
            env: env.optional(),
        }),
    ]);

/** Zod deliberately drops __proto__ record entries; reject them before parsing rather than silently discarding a requirement. */
export function rawFakeInputError(input: unknown): string | undefined {
    const object = (value: unknown): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value);
    const reserved = (value: unknown) =>
        object(value) &&
        ['__proto__', 'constructor', 'prototype'].some((key) =>
            Object.hasOwn(value, key),
        );
    if (reserved(input)) return 'fakes: reserved field';
    if (!object(input)) return undefined;
    for (const kind of ['email', 'stripe']) {
        const descriptor = input[kind];
        if (reserved(descriptor)) return 'fakes: reserved field';
        if (object(descriptor) && reserved(descriptor.env))
            return 'fakes.env: reserved environment name';
    }
    return undefined;
}

/** Closed local integrations; a declaration cannot add compose privileges or select a provider. */
export const RecipeFakesSchema = z.strictObject({
    stripe: descriptor(
        'stripe-mock',
        /^stripe\/stripe-mock@sha256:[a-f0-9]{64}$/,
    ).optional(),
    email: descriptor(
        'mailpit',
        /^axllent\/mailpit@sha256:[a-f0-9]{64}$/,
    ).optional(),
});

export interface RecipeFake {
    kind: 'email' | 'stripe';
    service: 'mailpit' | 'stripe-mock';
    image: string;
    env: Record<string, string>;
}

/** Aliases stay explicit until a trusted immutable pin is provided; no latest/default image is invented. */
export function normalizeRecipeFakes(
    input: z.infer<typeof RecipeFakesSchema> | undefined,
    baseEnv: Record<string, string>,
    checkEnv: (
        env: Record<string, string>,
        prefix: string,
    ) => string | undefined,
): RecipeFake[] | string {
    const out: RecipeFake[] = [];
    const values = new Map(Object.entries(baseEnv));
    for (const kind of ['email', 'stripe'] as const) {
        const raw = input?.[kind];
        if (raw === undefined) continue;
        const service = kind === 'email' ? 'mailpit' : 'stripe-mock';
        const fake: RecipeFake = {
            kind,
            service,
            image: raw === true ? service : raw.image,
            env: raw === true ? {} : (raw.env ?? {}),
        };
        const invalid = checkEnv(fake.env, `fakes.${kind}.env`);
        if (invalid) return invalid;
        for (const [key, value] of Object.entries(fake.env)) {
            if (values.has(key) && values.get(key) !== value)
                return `fakes: conflicting application environment ${key}`;
            values.set(key, value);
        }
        out.push(fake);
    }
    return out;
}
