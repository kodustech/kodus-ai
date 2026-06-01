import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';

import { PostHogProvider } from '@libs/telemetry/infrastructure/providers/posthog.provider';

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => mockLogger,
}));

jest.mock('posthog-node');

const MockedPostHog = PostHog as jest.MockedClass<typeof PostHog>;

const buildConfig = (overrides: Record<string, string | undefined> = {}) =>
    ({
        get: jest.fn((key: string) => overrides[key]),
    }) as unknown as ConfigService;

describe('PostHogProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('when API_POSTHOG_KEY is missing', () => {
        it('reports isEnabled = false and never constructs the SDK client', () => {
            const provider = new PostHogProvider(buildConfig({}));

            expect(provider.isEnabled).toBe(false);
            expect(MockedPostHog).not.toHaveBeenCalled();
        });

        it('makes capture/identify/groupIdentify pure no-ops (no log, no throw)', () => {
            const provider = new PostHogProvider(buildConfig({}));

            expect(() => {
                provider.capture('user-1', 'event', { foo: 'bar' });
                provider.identify('user-1', { email: 'a@b.com' });
                provider.groupIdentify('organization', 'org-1', { name: 'X' });
            }).not.toThrow();

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('when API_POSTHOG_KEY is present', () => {
        let captureSpy: jest.Mock;
        let identifySpy: jest.Mock;
        let groupIdentifySpy: jest.Mock;
        let isFeatureEnabledSpy: jest.Mock;
        const configWithKey = () =>
            buildConfig({ API_POSTHOG_KEY: 'phc_test_key' });

        beforeEach(() => {
            captureSpy = jest.fn();
            identifySpy = jest.fn();
            groupIdentifySpy = jest.fn();
            isFeatureEnabledSpy = jest.fn();
            MockedPostHog.mockImplementation(
                () =>
                    ({
                        capture: captureSpy,
                        identify: identifySpy,
                        groupIdentify: groupIdentifySpy,
                        isFeatureEnabled: isFeatureEnabledSpy,
                    }) as unknown as PostHog,
            );
        });

        it('forwards capture with the exact distinctId/event/properties and prunes undefined groups', () => {
            const provider = new PostHogProvider(configWithKey());

            provider.capture(
                'user-1',
                'user_signed_up',
                { email: 'a@b.com', plan: 'pro' },
                { organization: 'org-1', team: undefined, repository: 'r-1' },
            );

            expect(captureSpy).toHaveBeenCalledTimes(1);
            expect(captureSpy).toHaveBeenCalledWith({
                distinctId: 'user-1',
                event: 'user_signed_up',
                properties: { email: 'a@b.com', plan: 'pro' },
                groups: { organization: 'org-1', repository: 'r-1' },
            });
        });

        it('forwards identify with distinctId and properties', () => {
            const provider = new PostHogProvider(configWithKey());

            provider.identify('user-1', { email: 'a@b.com' });

            expect(identifySpy).toHaveBeenCalledWith({
                distinctId: 'user-1',
                properties: { email: 'a@b.com' },
            });
        });

        it('forwards groupIdentify with type/key/properties', () => {
            const provider = new PostHogProvider(configWithKey());

            provider.groupIdentify('team', 'team-1', {
                name: 'Engineering',
                organizationId: 'org-1',
            });

            expect(groupIdentifySpy).toHaveBeenCalledWith({
                groupType: 'team',
                groupKey: 'team-1',
                properties: { name: 'Engineering', organizationId: 'org-1' },
            });
        });

        describe('isFeatureEnabled', () => {
            const orgData = {
                organizationId: 'org-1',
                teamId: 'team-1',
            };

            it('sends only the organization group when no extra context is supplied', async () => {
                isFeatureEnabledSpy.mockResolvedValue(true);
                const provider = new PostHogProvider(configWithKey());

                const result = await provider.isFeatureEnabled(
                    'agent-review',
                    'user-1',
                    orgData,
                );

                expect(result).toBe(true);
                expect(isFeatureEnabledSpy).toHaveBeenCalledWith(
                    'agent-review',
                    'user-1',
                    { groups: { organization: 'org-1' } },
                );
            });

            it('merges extra groups in alongside the auto-set organization', async () => {
                isFeatureEnabledSpy.mockResolvedValue(true);
                const provider = new PostHogProvider(configWithKey());

                await provider.isFeatureEnabled(
                    'agent-review',
                    'user-1',
                    orgData,
                    {
                        groups: {
                            repository: 'repo-9',
                            directory: 'dir-42',
                        },
                    },
                );

                expect(isFeatureEnabledSpy).toHaveBeenCalledWith(
                    'agent-review',
                    'user-1',
                    {
                        groups: {
                            organization: 'org-1',
                            repository: 'repo-9',
                            directory: 'dir-42',
                        },
                    },
                );
            });

            it('drops undefined string values from the groups bag', async () => {
                isFeatureEnabledSpy.mockResolvedValue(true);
                const provider = new PostHogProvider(configWithKey());

                await provider.isFeatureEnabled(
                    'agent-review',
                    'user-1',
                    orgData,
                    { groups: { repository: undefined } },
                );

                expect(isFeatureEnabledSpy).toHaveBeenCalledWith(
                    'agent-review',
                    'user-1',
                    { groups: { organization: 'org-1' } },
                );
            });

            it('returns false when the SDK throws and swallows the error', async () => {
                isFeatureEnabledSpy.mockRejectedValue(new Error('boom'));
                const provider = new PostHogProvider(configWithKey());

                const result = await provider.isFeatureEnabled(
                    'agent-review',
                    'user-1',
                    orgData,
                );

                expect(result).toBe(false);
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                    'PostHog isFeatureEnabled threw',
                );
            });
        });

        describe('groupIdentify accepts directory group type', () => {
            it('forwards a directory group identify call to the SDK', () => {
                const provider = new PostHogProvider(configWithKey());

                provider.groupIdentify('directory', 'dir-42', {
                    path: 'apps/web/src',
                });

                expect(groupIdentifySpy).toHaveBeenCalledWith({
                    groupType: 'directory',
                    groupKey: 'dir-42',
                    properties: { path: 'apps/web/src' },
                });
            });
        });

        describe('groupIdentify accepts repositoryDirectory group type', () => {
            it('forwards the composite (repo, directory) group identify to the SDK', () => {
                const provider = new PostHogProvider(configWithKey());

                provider.groupIdentify(
                    'repositoryDirectory',
                    'repo-9:dir-42',
                    {
                        repositoryId: 'repo-9',
                        directoryId: 'dir-42',
                    },
                );

                expect(groupIdentifySpy).toHaveBeenCalledWith({
                    groupType: 'repositoryDirectory',
                    groupKey: 'repo-9:dir-42',
                    properties: {
                        repositoryId: 'repo-9',
                        directoryId: 'dir-42',
                    },
                });
            });
        });

        // ─── The reason the provider exists at all ──────────────────────
        // If the SDK throws synchronously (e.g. internal queue full,
        // serialization failure), the host flow MUST NOT propagate the
        // error. Each method swallows + logs warn so callers stay safe.
        describe('when the SDK throws synchronously', () => {
            beforeEach(() => {
                captureSpy.mockImplementation(() => {
                    throw new Error('queue exploded');
                });
                identifySpy.mockImplementation(() => {
                    throw new Error('queue exploded');
                });
                groupIdentifySpy.mockImplementation(() => {
                    throw new Error('queue exploded');
                });
            });

            it('swallows capture errors and logs a warn', () => {
                const provider = new PostHogProvider(configWithKey());

                expect(() =>
                    provider.capture('user-1', 'evt', {}),
                ).not.toThrow();
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                    'PostHog capture threw',
                );
            });

            it('swallows identify errors', () => {
                const provider = new PostHogProvider(configWithKey());

                expect(() => provider.identify('user-1', {})).not.toThrow();
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                    'PostHog identify threw',
                );
            });

            it('swallows groupIdentify errors', () => {
                const provider = new PostHogProvider(configWithKey());

                expect(() =>
                    provider.groupIdentify('organization', 'org-1', {}),
                ).not.toThrow();
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                    'PostHog groupIdentify threw',
                );
            });
        });
    });
});
