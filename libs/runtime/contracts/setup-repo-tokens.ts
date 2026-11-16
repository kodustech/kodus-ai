import { SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run/environment-setup';
import { SETUP_LEARN_BOOTS_MAX } from '@libs/runtime/run/setup-repo-tokens';

// The product's rules for POST /internal/runtime/setup-repo-tokens beside the
// contract the worker shares (libs/runtime/run/setup-repo-tokens.ts: the
// path, SetupRepoTokensRequestSchema, the response). `boot` is the setup's
// own first boot while it is `setting_up` (its request waited past the
// command's tokens, or the cell's download was refused with expired ones);
// `repair-<n>` is a boot of Kody's rewritten recipe while the setup is
// `setting_up`; `learn-<k>` is
// the learn loop's k-th clean boot (hypothesis h boots as 2h-1, its replay as
// 2h), answered while the setup is `blocked` and its loop holds hypothesis
// h of this very setup as `trying`.

export type SetupRepoTokensAttemptKind = 'boot' | 'repair' | 'learn';

/** The kind of a valid attempt and the number of what it boots: 0 for the first boot, the repair n, or the learn loop's hypothesis (`learn-3` and `learn-4` are hypothesis 2). */
export function setupRepoTokensAttemptOf(attempt: string): { kind: SetupRepoTokensAttemptKind; n: number } {
    if (attempt === 'boot') return { kind: 'boot', n: 0 };
    const [kind, k] = attempt.split('-');
    return kind === 'repair' ? { kind: 'repair', n: Number(k) } : { kind: 'learn', n: Math.ceil(Number(k) / 2) };
}

/**
 * The most calls one setup may make per kind: every boot it could make, plus
 * three asked again (the worker retries a connection reset, a timeout or a
 * 502/503 without a code with the same attempt, and each call mints anew).
 * Past it the product answers 429 { code: 'too_many_token_requests' } and
 * mints nothing.
 */
export const SETUP_REPO_TOKENS_CALLS_MAX: Record<SetupRepoTokensAttemptKind, number> = {
    // The first boot asks at most twice: before it boots, and once after its download was refused with expired tokens.
    boot: 2 + 3,
    repair: SETUP_AUTHOR_REPAIRS_MAX + 3,
    learn: SETUP_LEARN_BOOTS_MAX + 3,
};

/** The top-level `code` of each refusal with a body. */
export const SETUP_REPO_TOKENS_REFUSAL = {
    /** 409: the setup can boot nothing more for this attempt. */
    finished: 'setup_finished',
    /** 429: the setup asked more than its boots could need. */
    tooMany: 'too_many_token_requests',
} as const;
