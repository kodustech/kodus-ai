import { createServer, type IncomingMessage, type Server } from 'node:http';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { HeartbeatCollectorService } from '@libs/telemetry/application/services/heartbeat-collector.service';
import { SelfHostedBeaconService } from '@libs/telemetry/application/services/self-hosted-beacon.service';
import { BeaconHttpProvider } from '@libs/telemetry/infrastructure/providers/beacon-http.provider';

type CapturedRequest = {
    body: Record<string, unknown>;
    headers: IncomingMessage['headers'];
    method: string | undefined;
    url: string | undefined;
};

type TelemetryState = {
    instance_id: string;
    first_seen_at: string;
    last_sent_day: string | null;
    in_flight_day?: string | null;
    in_flight_started_at?: string | null;
};

async function startReceiver(): Promise<{
    close: () => Promise<void>;
    requests: CapturedRequest[];
    url: string;
}> {
    const requests: CapturedRequest[] = [];

    const server = createServer((req, res) => {
        let rawBody = '';

        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            rawBody += chunk;
        });
        req.on('end', () => {
            requests.push({
                body: rawBody ? JSON.parse(rawBody) : {},
                headers: req.headers,
                method: req.method,
                url: req.url,
            });

            res.writeHead(204);
            res.end();
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('receiver did not bind to a TCP port');
    }

    return {
        close: () => closeServer(server),
        requests,
        url: `http://127.0.0.1:${address.port}/v1/heartbeat`,
    };
}

function makeMongoModel(count: number) {
    return {
        countDocuments: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(count),
        }),
    };
}

function makeCollector(): HeartbeatCollectorService {
    const dataSource = {
        query: jest.fn(async (sql: string) => {
            if (sql.includes('SELECT version()')) {
                return [{ version: 'PostgreSQL 16.0 (Debian)' }];
            }
            if (sql.includes('FROM "organizations"')) {
                return [{ count: 1 }];
            }
            if (sql.includes('FROM "teams"')) {
                return [{ count: 2 }];
            }
            if (sql.includes('FROM "repositories"')) {
                return [{ count: 4 }];
            }
            if (sql.includes('FROM auth')) {
                return [{ count: 3 }];
            }
            if (sql.includes('FROM integrations')) {
                return [{ platform: 'github' }];
            }
            return [];
        }),
    };

    return new HeartbeatCollectorService(
        dataSource as never,
        makeMongoModel(9) as never,
        makeMongoModel(1) as never,
    );
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

describe('self-hosted telemetry HTTP flow', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
        jest.useRealTimers();
    });

    it('sends one real heartbeat POST to the configured receiver and marks the day as sent', async () => {
        const receiver = await startReceiver();
        process.env.KODUS_TELEMETRY_ENDPOINT = receiver.url;
        delete process.env.KODUS_TELEMETRY_DISABLED;

        let state: TelemetryState | null = {
            instance_id: '55555555-5555-4555-8555-555555555555',
            first_seen_at: '2026-01-01T00:00:00.000Z',
            last_sent_day: null,
        };

        const globalParameters = {
            findByKey: jest.fn(async (key: GlobalParametersKey) => {
                expect(key).toBe(GlobalParametersKey.TELEMETRY_STATE);
                return state ? { configValue: state } : null;
            }),
            createOrUpdateConfig: jest.fn(
                async (key: GlobalParametersKey, value: TelemetryState) => {
                    expect(key).toBe(GlobalParametersKey.TELEMETRY_STATE);
                    state = value;
                    return true;
                },
            ),
        };
        const collector = makeCollector();
        const collectSpy = jest.spyOn(collector, 'collect');

        try {
            const service = new SelfHostedBeaconService(
                globalParameters as never,
                collector as never,
                new BeaconHttpProvider(),
            );

            await service.run();
            await service.run();

            expect(receiver.requests).toHaveLength(1);
            expect(receiver.requests[0]).toEqual(
                expect.objectContaining({
                    method: 'POST',
                    url: '/v1/heartbeat',
                }),
            );
            expect(receiver.requests[0].headers['content-type']).toContain(
                'application/json',
            );
            const body = receiver.requests[0].body;
            expect(receiver.requests[0].headers['user-agent']).toBe(
                `kodus-self-hosted/${(body.kodus as { version: string }).version}`,
            );
            expect(body).toEqual(
                expect.objectContaining({
                    schema_version: 1,
                    instance_id: '55555555-5555-4555-8555-555555555555',
                    kodus: expect.objectContaining({
                        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
                    }),
                    runtime: expect.objectContaining({
                        db_version: 'PostgreSQL 16.0',
                    }),
                    usage_7d: expect.objectContaining({
                        active_users: 3,
                        organizations: 1,
                        repos_connected: 4,
                        prs_reviewed: 9,
                    }),
                    config: expect.objectContaining({
                        kody_rules_enabled: true,
                        integrations: ['github'],
                    }),
                }),
            );

            expect(state).toEqual(
                expect.objectContaining({
                    instance_id: '55555555-5555-4555-8555-555555555555',
                    last_sent_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
                    in_flight_day: null,
                    in_flight_started_at: null,
                }),
            );
            expect(collectSpy).toHaveBeenCalledTimes(1);
        } finally {
            await receiver.close();
        }
    });
});
