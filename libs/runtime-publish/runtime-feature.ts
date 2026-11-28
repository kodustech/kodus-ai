/**
 * Whether this deployment runs Kody Runtime in the product worker: the
 * publish and trigger consumers, and the pull request events written for the
 * trigger. `RUNTIME_ENABLED=true|false` decides; unset, it follows
 * `RUNTIME_RUN_TOKEN_SECRET`, without which no Run can be enqueued anyway.
 * Off, the Runtime costs the worker nothing: no consumers, no outbox rows
 * (the shared topology still declares its queues, empty).
 * The worker module passes its process environment, read once at boot.
 */
export function isKodyRuntimeEnabled(env: NodeJS.ProcessEnv): boolean {
    const flag = env.RUNTIME_ENABLED?.trim().toLowerCase();
    if (flag === 'true' || flag === '1') return true;
    if (flag === 'false' || flag === '0') return false;
    return !!env.RUNTIME_RUN_TOKEN_SECRET;
}

/**
 * The product process's own switch: `isKodyRuntimeEnabled` over its process
 * environment. The one place outside the loaders that reads it, for the
 * API's crons and controllers that must stay idle when the Runtime is off.
 */
export function kodyRuntimeEnabledInThisProcess(): boolean {
    return isKodyRuntimeEnabled(process.env);
}
