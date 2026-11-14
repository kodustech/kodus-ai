/**
 * Whether this deployment runs Kody Runtime in the product worker: the
 * publish and trigger consumers, and the pull request events written for the
 * trigger. `RUNTIME_ENABLED=true|false` decides; unset, it follows
 * `RUNTIME_RUN_TOKEN_SECRET`, without which no Run can be enqueued anyway.
 * Off, the Runtime costs the worker nothing: no queues, no outbox rows.
 */
export function isKodyRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const flag = env.RUNTIME_ENABLED?.trim().toLowerCase();
    if (flag === 'true' || flag === '1') return true;
    if (flag === 'false' || flag === '0') return false;
    return !!env.RUNTIME_RUN_TOKEN_SECRET;
}
