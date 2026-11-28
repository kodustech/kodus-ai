import { z } from 'zod';

import { isSealedSecret } from '@libs/runtime/run/sealed-secret';

// Values both sides of a process boundary check the same way, so one schema
// cannot be laxer than its sibling.

/** A token that travels sealed (run/sealed-secret.ts, `sealed:v1:…`): a plain one is refused. */
export const SealedTokenSchema = z
    .string()
    .min(1)
    .max(8_192)
    .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' });

/**
 * An exact hostname: lowercase, no port, no scheme, no trailing dot, no
 * wildcard. The proxy and the resolver compare it byte for byte, and the
 * protocol (protocol/messages.ts) refuses any other form.
 */
export const EXACT_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const ExactHostnameSchema = z.string().min(1).max(253).regex(EXACT_HOSTNAME);

/**
 * A host a person typed, as the exact hostname: lowercased and without a
 * trailing dot first, then checked. A wildcard, a port, a scheme or a path
 * is refused.
 */
export const EgressHostSchema = z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : v), ExactHostnameSchema);
