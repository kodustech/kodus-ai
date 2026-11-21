import { randomUUID } from 'node:crypto';

import type { Attributes, AttributeValue } from '@opentelemetry/api';
import { SDK_INFO } from '@opentelemetry/core';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

// The OpenTelemetry resource of a Runtime process: who emitted a span or a
// metric. NodeTracerProvider and MeterProvider, used directly (not NodeSDK),
// default to `unknown_service:node` and read no OTEL_* variable for it, so
// otel.ts hands them this one. The `Resource` interface is the SDK's own
// (taken from NodeTracerProvider's config type); building it here keeps
// `@opentelemetry/resources` out of package.json (a lockfile change means a
// dependency install on every dev container that shares the node_modules
// volume). Attribute names: OpenTelemetry semantic conventions, service.*.

type Resource = NonNullable<NonNullable<ConstructorParameters<typeof NodeTracerProvider>[0]>['resource']>;
type Env = Record<string, string | undefined>;

export interface RuntimeProcessIdentity {
    /** `service.name`: the process (runtime-hub, runtime-worker, runtime-preview-edge). */
    serviceName: string;
    /** `service.version`: the release the process runs, when it has one. */
    serviceVersion?: string;
    /** `service.instance.id`: the replica the deployment names; else a random UUID per process, as the conventions advise. */
    serviceInstanceId?: string;
}

class RuntimeResource implements Resource {
    readonly asyncAttributesPending = false;
    constructor(readonly attributes: Attributes) {}
    async waitForAsyncAttributes(): Promise<void> {}
    getRawAttributes(): [string, AttributeValue | undefined][] {
        return Object.entries(this.attributes);
    }
    /** As the SDK's: the other resource's attributes win. */
    merge(other: Resource | null): Resource {
        return other ? new RuntimeResource({ ...this.attributes, ...other.attributes }) : this;
    }
}

/**
 * OTEL_RESOURCE_ATTRIBUTES as the SDK environment specification defines it:
 * comma-separated `key=value`, values percent-decoded. A pair without a key,
 * without `=` or with a bad escape is skipped.
 */
export function parseResourceAttributes(raw: string | undefined): Attributes {
    const out: Attributes = {};
    for (const pair of (raw ?? '').split(',')) {
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const key = pair.slice(0, at).trim();
        if (!key) continue;
        try {
            out[key] = decodeURIComponent(pair.slice(at + 1).trim());
        } catch {
            // A bad percent escape skips the pair, as the specification above says.
            continue;
        }
    }
    return out;
}

/**
 * The process's resource. Precedence, lowest first: the SDK's telemetry.sdk.*,
 * the identity the process passes, OTEL_RESOURCE_ATTRIBUTES, then
 * OTEL_SERVICE_NAME (the specification: it wins over a service.name in
 * OTEL_RESOURCE_ATTRIBUTES).
 */
export function runtimeResource(identity: RuntimeProcessIdentity, env: Env = process.env): Resource {
    const attributes: Attributes = {
        ...SDK_INFO,
        'service.name': identity.serviceName,
        ...(identity.serviceVersion ? { 'service.version': identity.serviceVersion } : {}),
        'service.instance.id': identity.serviceInstanceId || randomUUID(),
        ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    };
    const serviceName = env.OTEL_SERVICE_NAME?.trim();
    if (serviceName) attributes['service.name'] = serviceName;
    return new RuntimeResource(attributes);
}
