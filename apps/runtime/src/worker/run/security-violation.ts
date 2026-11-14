import type { EnvError } from '@libs/runtime/environment';

/**
 * The cell reported that one side's code exfiltrated (blocked
 * security_violation): that claim runs nothing more and the Run halts as a
 * failing check. Thrown outside a durable step, from a value the step
 * recorded, so a resumed workflow halts the same way.
 */
export class SecurityViolationError extends Error {
    readonly code = 'security_violation';
    constructor(
        readonly side: 'base' | 'pr',
        readonly signature: string,
    ) {
        super(`security violation on the ${side} claim (${signature})`);
        this.name = 'SecurityViolationError';
    }
}

export type SecurityViolation = { side: 'base' | 'pr'; signature: string };

export const isSecurityViolation = (r: unknown): r is Extract<EnvError, { code: 'security_violation' }> =>
    typeof r === 'object' && r !== null && (r as { code?: unknown }).code === 'security_violation';
