import * as os from 'os';

import { runtimeIdentity } from '@libs/core/log/runtime-identity';

type HeartbeatValue = Date | number | string | undefined;

function normalizeHeartbeatValue(value: HeartbeatValue): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    return String(value);
}

export function buildHeartbeatContext(
    env?: string,
    component?: string,
    extra: Record<string, HeartbeatValue> = {},
): Record<string, string> {
    // version and taskId: which release and which ECS task sent the alert.
    // For a monitor (reclaim, reap) that is the task that noticed, not the
    // one whose work was lost; those name the lost work's owner in `extra`.
    const context = {
        env,
        component,
        host: os.hostname(),
        ...runtimeIdentity(),
        ...extra,
    };

    const formatted: Record<string, string> = {};
    for (const [key, value] of Object.entries(context)) {
        const normalized = normalizeHeartbeatValue(value);
        if (normalized && normalized.length > 0) {
            formatted[key] = normalized;
        }
    }

    return formatted;
}

/**
 * @deprecated Use buildHeartbeatContext to pass a JSON context to failHeartbeat instead
 */
export function formatHeartbeatContext(
    env?: string,
    component?: string,
    extra: Record<string, HeartbeatValue> = {},
): string {
    const context = buildHeartbeatContext(env, component, extra);

    return Object.entries(context)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
}
