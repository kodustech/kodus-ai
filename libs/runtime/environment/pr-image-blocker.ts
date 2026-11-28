import type { Blocked } from './environment-runtime';

/** The signature of a Run-mode suite shard refused because the PR image its Run's PR side builds is not there. */
export const PR_IMAGE_UNAVAILABLE = 'pr_image_unavailable';

/**
 * A suite shard of a Run never rebuilds the PR on its own host: the Run's PR side builds it once and publishes it to the image
 * store. When that image failed or never came the shard is refused with the cause, and the engine reports its specs `not_run`
 * with this message, not as an infrastructure failure to retry on another cold host.
 */
export function prImageUnavailable(cause: string): Blocked {
    return { status: 'blocked', blockers: [{ kind: 'platform', signature: PR_IMAGE_UNAVAILABLE, message: `PR image unavailable: ${cause}` }] };
}

/** The message of a refusal made by `prImageUnavailable`, else undefined. */
export function prImageUnavailableMessage(r: unknown): string | undefined {
    const b = r as Blocked | undefined;
    if (b?.status !== 'blocked') return undefined;
    return b.blockers.find((x) => x.signature === PR_IMAGE_UNAVAILABLE)?.message;
}
