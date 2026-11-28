import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupRuntimeOtel } from './otel';
import { parseResourceAttributes, runtimeResource } from './resource';
import { inSpan } from './tracing';

// Each Runtime process exports its spans and its metrics under its own
// service.name (runtime-hub, runtime-worker, runtime-preview-edge), so a trace
// backend tells them apart; OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
// change it as the OpenTelemetry SDK specification says.

function freePort(): Promise<number> {
    const s = createServer();
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(port));
    }));
}

describe('setupRuntimeOtel: the resource of a Runtime process', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    for (const identity of [
        { serviceName: 'runtime-hub', serviceInstanceId: 'hub-dev-1' },
        { serviceName: 'runtime-worker', serviceVersion: 'next-20261113' },
        { serviceName: 'runtime-preview-edge', serviceInstanceId: 'edge-dev-1' },
    ]) {
        it(`${identity.serviceName}'s exported spans and its metrics carry its service.name`, async () => {
            // The console exporter, not OTLP: the OTLP transport loads node:http
            // with a dynamic import(), which jest's CommonJS runtime never settles.
            // Both exporters read the same span.resource, behind the same redaction.
            const metricsPort = await freePort();
            delete process.env.OTEL_SERVICE_NAME;
            delete process.env.OTEL_RESOURCE_ATTRIBUTES;
            delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            process.env.OTEL_TRACES_EXPORTER = 'console';
            const dir = jest.spyOn(console, 'dir').mockImplementation(() => undefined);
            const shutdown = await setupRuntimeOtel(identity, metricsPort);
            let scrape: string;
            let exported: { name: string; resource: { attributes: Record<string, unknown> } }[];
            try {
                await inSpan('fixture.span', {}, async () => undefined);
                scrape = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
            } finally {
                await shutdown();
                exported = dir.mock.calls.map(([span]) => span as (typeof exported)[number]);
                dir.mockRestore();
            }
            expect(exported.map((s) => s.name)).toEqual(['fixture.span']);
            expect(exported[0].resource.attributes).toMatchObject({
                'service.name': identity.serviceName,
                'telemetry.sdk.language': 'nodejs',
            });
            expect(exported[0].resource.attributes['service.version']).toBe(identity.serviceVersion);
            expect(exported[0].resource.attributes['service.instance.id']).toEqual(
                identity.serviceInstanceId ?? expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
            );
            expect(scrape).toMatch(new RegExp(`target_info\\{[^}]*service_name="${identity.serviceName}"`));
        });
    }
});

describe('runtimeResource', () => {
    it('OTEL_RESOURCE_ATTRIBUTES adds and overrides attributes, OTEL_SERVICE_NAME wins over both', () => {
        const r = runtimeResource({ serviceName: 'runtime-hub', serviceVersion: 'v1' }, {
            OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=dev,service.name=from-attributes,service.version=v2',
            OTEL_SERVICE_NAME: 'from-env',
        });
        expect(r.attributes).toMatchObject({
            'service.name': 'from-env',
            'service.version': 'v2',
            'deployment.environment.name': 'dev',
        });
    });

    it('keeps the process name when the variables are unset or blank', () => {
        expect(runtimeResource({ serviceName: 'runtime-worker' }, { OTEL_SERVICE_NAME: ' ' }).attributes['service.name']).toBe('runtime-worker');
    });

    it('a merged resource takes the other one\'s attributes, as the SDK does', () => {
        const merged = runtimeResource({ serviceName: 'runtime-hub' }, {}).merge(runtimeResource({ serviceName: 'other' }, {}));
        expect(merged.attributes['service.name']).toBe('other');
    });

    it('parses the variable as the SDK environment specification says', () => {
        expect(parseResourceAttributes(' a = x%20y ,=nokey,novalue,b=%E0%A4%A,c=1=2,')).toEqual({ a: 'x y', c: '1=2' });
        expect(parseResourceAttributes(undefined)).toEqual({});
    });
});
