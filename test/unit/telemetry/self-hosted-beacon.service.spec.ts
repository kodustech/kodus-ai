import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { SelfHostedBeaconService } from '@libs/telemetry/application/services/self-hosted-beacon.service';

type MockGlobalParameters = {
    findByKey: jest.Mock;
    createOrUpdateConfig: jest.Mock;
};

type MockCollector = {
    collect: jest.Mock;
};

type MockTransport = {
    isDisabled: jest.Mock;
    send: jest.Mock;
};

function makeMetrics(version = '1.2.3') {
    return {
        kodus: {
            version,
            deployment: 'docker' as const,
            uptime_hours: 5,
        },
        runtime: {
            node_version: 'v20.0.0',
            os: 'linux' as const,
            arch: 'x64',
            cpu_count: 4,
            db_type: 'postgres',
            db_version: 'PostgreSQL 15.4',
        },
        usage_7d: {
            active_users: 3,
            organizations: 1,
            teams: 2,
            repos_connected: 4,
            prs_reviewed: 9,
            suggestions_generated: 0,
            suggestions_applied: 0,
        },
        config: {
            kody_rules_enabled: true,
            agent_review_repos_pct: 0,
            integrations: ['github', 'slack'],
        },
    };
}

function build(): {
    service: SelfHostedBeaconService;
    globalParameters: MockGlobalParameters;
    collector: MockCollector;
    transport: MockTransport;
} {
    const globalParameters: MockGlobalParameters = {
        findByKey: jest.fn(),
        createOrUpdateConfig: jest.fn().mockResolvedValue(true),
    };
    const collector: MockCollector = {
        collect: jest.fn().mockResolvedValue(makeMetrics()),
    };
    const transport: MockTransport = {
        isDisabled: jest.fn().mockReturnValue(false),
        send: jest.fn().mockResolvedValue(true),
    };

    const service = new SelfHostedBeaconService(
        globalParameters as never,
        collector as never,
        transport as never,
    );

    return { service, globalParameters, collector, transport };
}

describe('SelfHostedBeaconService', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('skips entirely when telemetry is disabled', async () => {
        const { service, globalParameters, collector, transport } = build();
        transport.isDisabled.mockReturnValue(true);

        await service.run();

        expect(globalParameters.findByKey).not.toHaveBeenCalled();
        expect(collector.collect).not.toHaveBeenCalled();
        expect(transport.send).not.toHaveBeenCalled();
        expect(globalParameters.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('creates and persists state on first run, then sends', async () => {
        const { service, globalParameters, collector, transport } = build();
        globalParameters.findByKey.mockResolvedValue(null);

        await service.run();

        expect(globalParameters.findByKey).toHaveBeenCalledWith(
            GlobalParametersKey.TELEMETRY_STATE,
        );

        // First persist: brand-new state with a UUID + first_seen_at and no
        // last_sent_day yet.
        const firstPersist =
            globalParameters.createOrUpdateConfig.mock.calls[0]?.[1];
        expect(firstPersist).toEqual(
            expect.objectContaining({
                instance_id: expect.stringMatching(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
                ),
                first_seen_at: expect.any(String),
                last_sent_day: null,
                in_flight_day: null,
                in_flight_started_at: null,
            }),
        );

        expect(collector.collect).toHaveBeenCalledTimes(1);
        expect(transport.send).toHaveBeenCalledTimes(1);

        // Second persist: claims today before sending so another worker skips.
        const secondPersist =
            globalParameters.createOrUpdateConfig.mock.calls[1]?.[1];
        expect(secondPersist).toEqual(
            expect.objectContaining({
                instance_id: firstPersist.instance_id,
                last_sent_day: null,
                in_flight_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
                in_flight_started_at: expect.any(String),
            }),
        );

        // Third persist: marks today as sent and clears the in-flight claim.
        const thirdPersist =
            globalParameters.createOrUpdateConfig.mock.calls[2]?.[1];
        expect(thirdPersist).toEqual(
            expect.objectContaining({
                instance_id: firstPersist.instance_id,
                last_sent_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
                in_flight_day: null,
                in_flight_started_at: null,
            }),
        );
    });

    it('skips send when last_sent_day equals today', async () => {
        const { service, globalParameters, collector, transport } = build();
        const today = new Date().toISOString().slice(0, 10);

        globalParameters.findByKey.mockResolvedValue({
            configValue: {
                instance_id: '11111111-1111-4111-8111-111111111111',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_sent_day: today,
            },
        });

        await service.run();

        expect(collector.collect).not.toHaveBeenCalled();
        expect(transport.send).not.toHaveBeenCalled();
        expect(globalParameters.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('does not advance last_sent_day if transport reports failure', async () => {
        const { service, globalParameters, collector, transport } = build();
        globalParameters.findByKey.mockResolvedValue({
            configValue: {
                instance_id: '22222222-2222-4222-8222-222222222222',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_sent_day: '2026-01-01',
            },
        });
        transport.send.mockResolvedValue(false);

        await service.run();

        expect(collector.collect).toHaveBeenCalledTimes(1);
        expect(transport.send).toHaveBeenCalledTimes(1);
        expect(globalParameters.createOrUpdateConfig).toHaveBeenCalledTimes(2);

        const claimPersist =
            globalParameters.createOrUpdateConfig.mock.calls[0]?.[1];
        expect(claimPersist).toEqual(
            expect.objectContaining({
                last_sent_day: '2026-01-01',
                in_flight_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
                in_flight_started_at: expect.any(String),
            }),
        );

        const clearPersist =
            globalParameters.createOrUpdateConfig.mock.calls[1]?.[1];
        expect(clearPersist).toEqual(
            expect.objectContaining({
                last_sent_day: '2026-01-01',
                in_flight_day: null,
                in_flight_started_at: null,
            }),
        );
    });

    it('skips send when another worker already claimed today', async () => {
        const { service, globalParameters, collector, transport } = build();
        const now = new Date('2026-06-01T03:17:30.000Z');
        jest.useFakeTimers().setSystemTime(now);

        globalParameters.findByKey.mockResolvedValue({
            configValue: {
                instance_id: '22222222-2222-4222-8222-222222222222',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_sent_day: '2026-01-01',
                in_flight_day: '2026-06-01',
                in_flight_started_at: '2026-06-01T03:17:00.000Z',
            },
        });

        await service.run();

        expect(collector.collect).not.toHaveBeenCalled();
        expect(transport.send).not.toHaveBeenCalled();
        expect(globalParameters.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('swallows collector errors so the cron never fails', async () => {
        const { service, globalParameters, collector, transport } = build();
        globalParameters.findByKey.mockResolvedValue({
            configValue: {
                instance_id: '33333333-3333-4333-8333-333333333333',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_sent_day: null,
            },
        });
        collector.collect.mockRejectedValue(new Error('db down'));

        await expect(service.run()).resolves.toBeUndefined();
        expect(transport.send).not.toHaveBeenCalled();
        expect(globalParameters.createOrUpdateConfig).toHaveBeenCalledTimes(2);
        expect(
            globalParameters.createOrUpdateConfig.mock.calls[1]?.[1],
        ).toEqual(
            expect.objectContaining({
                in_flight_day: null,
                in_flight_started_at: null,
            }),
        );
    });

    it('preview returns the payload that would be sent without calling transport', async () => {
        const { service, globalParameters, collector, transport } = build();
        globalParameters.findByKey.mockResolvedValue({
            configValue: {
                instance_id: '44444444-4444-4444-8444-444444444444',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_sent_day: null,
            },
        });

        const payload = await service.preview();

        expect(payload).toEqual(
            expect.objectContaining({
                schema_version: 1,
                instance_id: '44444444-4444-4444-8444-444444444444',
                sent_at: expect.any(String),
                kodus: expect.any(Object),
                runtime: expect.any(Object),
                usage_7d: expect.any(Object),
                config: expect.any(Object),
            }),
        );
        expect(transport.send).not.toHaveBeenCalled();
    });
});
