import * as os from 'os';

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
    const context = {
        env,
        component,
        host: os.hostname(),
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
