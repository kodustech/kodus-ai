import type { FeaturesSnapshot } from '@libs/feature-gate/domain/snapshot.types';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const mockedSnapshot: { current: FeaturesSnapshot } = {
    current: emptySnapshot(),
};

jest.mock('@libs/feature-gate/infrastructure/feature-snapshot.loader', () => ({
    loadSnapshot: () => mockedSnapshot.current,
}));

const mockedEnvironment: { API_CLOUD_MODE: boolean } = { API_CLOUD_MODE: true };

jest.mock('@libs/ee/configs/environment/environment', () => ({
    get environment() {
        return mockedEnvironment;
    },
}));

import { FeatureGateService } from '@libs/feature-gate/application/feature-gate.service';
import { FEATURE_KEYS } from '@libs/feature-gate/domain/feature-keys';

const orgCtx = {
    identifier: 'user-1',
    organizationAndTeamData: {
        organizationId: 'org-1',
        teamId: 'team-1',
    },
};

function emptySnapshot(): FeaturesSnapshot {
    return {
        schema_version: 1,
        generated_at: '2026-05-06T00:00:00.000Z',
        source: 'manual',
        features: {},
    };
}

function snapshotWith(
    key: string,
    overrides: Partial<FeaturesSnapshot['features'][string]> = {},
): FeaturesSnapshot {
    return {
        schema_version: 1,
        generated_at: '2026-05-06T00:00:00.000Z',
        source: 'manual',
        features: {
            [key]: {
                name: 'Test feature',
                stage: 'beta',
                ...overrides,
            },
        },
    };
}

function fakePostHog(
    impl?: (feature: string) => Promise<boolean>,
): { isFeatureEnabled: jest.Mock } {
    return {
        isFeatureEnabled: jest.fn(
            impl ?? (async () => true),
        ),
    };
}

describe('FeatureGateService', () => {
    afterEach(() => {
        delete process.env.BETA_FEATURES;
        mockedSnapshot.current = emptySnapshot();
        mockedEnvironment.API_CLOUD_MODE = true;
        jest.resetModules();
    });

    describe('cloud', () => {
        beforeEach(() => {
            mockedEnvironment.API_CLOUD_MODE = true;
        });

        it('delegates to PostHog when the feature is in the snapshot', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'beta',
                audience: ['cloud', 'self-hosted'],
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            const result = await svc.isEnabled(
                FEATURE_KEYS.agentReview,
                orgCtx,
            );

            expect(result).toBe(true);
            expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(
                FEATURE_KEYS.agentReview,
                orgCtx.identifier,
                orgCtx.organizationAndTeamData,
                undefined,
            );
        });

        it('returns false when PostHog says no, regardless of stage', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'general-availability',
            });
            const posthog = fakePostHog(async () => false);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(false);
        });

        it('falls back to snapshot stage when PostHog throws (GA stays on)', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'general-availability',
            });
            const posthog = fakePostHog(async () => {
                throw new Error('posthog down');
            });
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(true);
        });

        it('falls back to deny when PostHog throws on a beta feature', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'beta',
            });
            const posthog = fakePostHog(async () => {
                throw new Error('posthog down');
            });
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(false);
        });

        it('returns true (legacy compat) when the feature is missing from the snapshot', async () => {
            mockedSnapshot.current = emptySnapshot();
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(true);
        });

        it('forwards a single group key to PostHog (rollout boundary)', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview);
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await svc.isEnabled(FEATURE_KEYS.agentReview, {
                ...orgCtx,
                groups: { repository: 'repo-9' },
            });

            expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(
                FEATURE_KEYS.agentReview,
                orgCtx.identifier,
                orgCtx.organizationAndTeamData,
                { groups: { repository: 'repo-9' } },
            );
        });

        it('forwards multiple group keys together (one id per type)', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview);
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await svc.isEnabled(FEATURE_KEYS.agentReview, {
                ...orgCtx,
                groups: {
                    repository: 'repo-9',
                    directory: 'dir-42',
                },
            });

            expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(
                FEATURE_KEYS.agentReview,
                orgCtx.identifier,
                orgCtx.organizationAndTeamData,
                {
                    groups: {
                        repository: 'repo-9',
                        directory: 'dir-42',
                    },
                },
            );
        });

        it('blocks stable-track orgs from beta features (track gate before flag)', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'beta',
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, {
                    ...orgCtx,
                    releaseTrack: 'stable',
                }),
            ).resolves.toBe(false);
            expect(posthog.isFeatureEnabled).not.toHaveBeenCalled();
        });

        it('lets alpha-track orgs see beta features', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'beta',
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, {
                    ...orgCtx,
                    releaseTrack: 'alpha',
                }),
            ).resolves.toBe(true);
        });

        it('alpha-track orgs see alpha features', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'alpha',
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, {
                    ...orgCtx,
                    releaseTrack: 'alpha',
                }),
            ).resolves.toBe(true);
            expect(posthog.isFeatureEnabled).toHaveBeenCalled();
        });

        it('beta-track orgs are blocked from alpha features', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'alpha',
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, {
                    ...orgCtx,
                    releaseTrack: 'beta',
                }),
            ).resolves.toBe(false);
            expect(posthog.isFeatureEnabled).not.toHaveBeenCalled();
        });

        it('alpha track still respects PostHog flag denial (operational tuning)', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'alpha',
            });
            const posthog = fakePostHog(async () => false);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, {
                    ...orgCtx,
                    releaseTrack: 'alpha',
                }),
            ).resolves.toBe(false);
        });

        it('GA features ignore the track gate and always pass to PostHog', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'general-availability',
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, {
                    ...orgCtx,
                    releaseTrack: 'stable',
                }),
            ).resolves.toBe(true);
        });

        it('blocks features whose audience excludes cloud', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'general-availability',
                audience: ['self-hosted'],
            });
            const posthog = fakePostHog(async () => true);
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(false);
        });
    });

    describe('self-hosted', () => {
        beforeEach(() => {
            mockedEnvironment.API_CLOUD_MODE = false;
        });

        it('returns true for general-availability features without env flags', async () => {
            mockedSnapshot.current = snapshotWith(
                FEATURE_KEYS.agentReview,
                {
                    stage: 'general-availability',
                    audience: ['cloud', 'self-hosted'],
                },
            );
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(true);
            expect(posthog.isFeatureEnabled).not.toHaveBeenCalled();
        });

        it('returns true for beta features when BETA_FEATURES=true', async () => {
            process.env.BETA_FEATURES = 'true';
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'beta',
                audience: ['cloud', 'self-hosted'],
            });
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(true);
        });

        it('returns false for beta features when BETA_FEATURES is unset', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'beta',
                audience: ['cloud', 'self-hosted'],
            });
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(false);
        });

        it('returns false for alpha features even with BETA_FEATURES=true', async () => {
            process.env.BETA_FEATURES = 'true';
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'alpha',
                audience: ['cloud', 'self-hosted'],
            });
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(false);
        });

        it('returns false when audience excludes self-hosted', async () => {
            mockedSnapshot.current = snapshotWith(FEATURE_KEYS.agentReview, {
                stage: 'general-availability',
                audience: ['cloud'],
            });
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(false);
        });

        it('returns true (legacy compat) when feature is missing from snapshot', async () => {
            mockedSnapshot.current = emptySnapshot();
            const posthog = fakePostHog();
            const svc = new FeatureGateService(posthog as never);

            await expect(
                svc.isEnabled(FEATURE_KEYS.agentReview, orgCtx),
            ).resolves.toBe(true);
        });
    });
});
