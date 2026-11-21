import { createHmac, timingSafeEqual } from 'crypto';

import { z } from 'zod';

// The Run token (ADR-057): the only credential the runtime-worker has for the
// product's LLM gateway. The product signs it when it publishes the
// RuntimeRunRequested; it names one Run and expires. The worker never holds an
// LLM key.

export interface RunTokenClaims {
    runId: string;
    attempt: number;
    organizationId: string;
    teamId: string;
    repositoryId: string;
    prNumber: number;
    /** Token ceiling of this Run; the gateway applies the lower of this and its own limit. */
    maxTokens?: number;
    /** Expiry, seconds since epoch. */
    exp: number;
}

const PREFIX = 'krt1';

const id = z.string().min(1).max(128);
/** Every claim, checked after the signature: a signed token with a malformed claim is still refused. */
const RunTokenClaimsSchema = z.strictObject({
    runId: id,
    attempt: z.number().int().min(1),
    organizationId: id,
    teamId: id,
    repositoryId: id,
    prNumber: z.number().int().min(1),
    maxTokens: z.number().int().min(1).optional(),
    exp: z.number().int().min(1),
});
/** A Run lasts at most 45 min of machine time (§11); the token outlives it a little for the publish. */
export const RUN_TOKEN_DEFAULT_TTL_SECONDS = 2 * 60 * 60;

export class InvalidRunTokenError extends Error {
    constructor(readonly reason: 'malformed' | 'signature' | 'expired') {
        super(`invalid run token: ${reason}`);
    }
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function mac(secret: string, body: string, prefix = PREFIX) {
    return createHmac('sha256', secret).update(`${prefix}.${body}`).digest();
}

function assertSecret(secret: string) {
    if (!secret || secret.length < 32) {
        throw new Error('run token secret must have at least 32 characters');
    }
}

export function signRunToken(claims: RunTokenClaims, secret: string): string {
    assertSecret(secret);
    const body = b64(JSON.stringify(claims));
    return `${PREFIX}.${body}.${b64(mac(secret, body))}`;
}

export function verifyRunToken(token: string, secret: string, now = new Date()): RunTokenClaims {
    return verifySigned(token, secret, now, PREFIX, RunTokenClaimsSchema);
}

function verifySigned<T extends { exp: number }>(token: string, secret: string, now: Date, prefix: string, schema: z.ZodType<T>): T {
    assertSecret(secret);
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== prefix || token.length > 4_096) {
        throw new InvalidRunTokenError('malformed');
    }
    const [, body, sig] = parts;
    const expected = mac(secret, body, prefix);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new InvalidRunTokenError('signature');
    }
    // The signature covers the encoded body; a non-canonical encoding of the same bytes is refused too.
    if (b64(Buffer.from(sig, 'base64url')) !== sig || b64(Buffer.from(body, 'base64url')) !== body) {
        throw new InvalidRunTokenError('malformed');
    }
    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        throw new InvalidRunTokenError('malformed');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new InvalidRunTokenError('malformed');
    const claims = parsed.data;
    if (claims.exp * 1000 <= now.getTime()) {
        throw new InvalidRunTokenError('expired');
    }
    return claims;
}

// The setup token: the same credential for one environment setup, so Kody's
// learn loop (docs "Ciclo de aprender") calls the gateway budgeted like a Run.
// Its own prefix keys the signature, so a Run token never passes as a setup
// token or the other way round.

export interface SetupTokenClaims {
    /** The setup's idempotency key (`environmentId:requestedAt`). */
    setupKey: string;
    environmentId: string;
    organizationId: string;
    teamId: string;
    repositoryId: string;
    /** Token ceiling of this setup's learn loop. */
    maxTokens?: number;
    exp: number;
}

const SETUP_PREFIX = 'kst1';

const SetupTokenClaimsSchema = z.strictObject({
    setupKey: z.string().min(1).max(256),
    environmentId: id,
    organizationId: id,
    teamId: id,
    repositoryId: id,
    maxTokens: z.number().int().min(1).optional(),
    exp: z.number().int().min(1),
});

export const isSetupToken = (token: string) => typeof token === 'string' && token.startsWith(`${SETUP_PREFIX}.`);

export function signSetupToken(claims: SetupTokenClaims, secret: string): string {
    assertSecret(secret);
    const body = b64(JSON.stringify(claims));
    return `${SETUP_PREFIX}.${body}.${b64(mac(secret, body, SETUP_PREFIX))}`;
}

export function verifySetupToken(token: string, secret: string, now = new Date()): SetupTokenClaims {
    return verifySigned(token, secret, now, SETUP_PREFIX, SetupTokenClaimsSchema);
}
