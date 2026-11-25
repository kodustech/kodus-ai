jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock('@libs/ee/configs/environment/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

import fs from 'fs';

import { FeatureGateService } from '@libs/feature-gate/application/feature-gate.service';
import {
    ALL_FEATURE_KEYS,
    FEATURE_KEYS,
} from '@libs/feature-gate/domain/feature-keys';
import { loadSnapshot } from '@libs/feature-gate/infrastructure/feature-snapshot.loader';

// Uses the real loader on purpose: the API/worker images ship `dist/` but
// not `release/`, so a loader that reads the JSON from disk returned an
// empty catalog in production and every gate fell through to PostHog.
describe('feature snapshot loader', () => {
    beforeAll(() => {
        const readFileSync = fs.readFileSync;
        jest.spyOn(fs, 'readFileSync').mockImplementation(((
            path: fs.PathOrFileDescriptor,
            ...rest: unknown[]
        ) => {
            if (String(path).endsWith('features-snapshot.json')) {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
            return (readFileSync as (...args: unknown[]) => unknown)(
                path,
                ...rest,
            );
        }) as typeof fs.readFileSync);
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    it('carries every feature key without reading release/ from disk', () => {
        const snapshot = loadSnapshot();

        for (const key of ALL_FEATURE_KEYS) {
            expect(snapshot.features[key]).toBeDefined();
        }
    });

    it('gates conditional approval in cloud by release track, never PostHog', async () => {
        const posthog = { isFeatureEnabled: jest.fn(async () => true) };
        const svc = new FeatureGateService(posthog as never);
        const ctx = {
            identifier: 'org-1',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        };

        await expect(
            svc.isEnabled(FEATURE_KEYS.conditionalPrApproval, {
                ...ctx,
                releaseTrack: 'beta',
            }),
        ).resolves.toBe(true);
        await expect(
            svc.isEnabled(FEATURE_KEYS.conditionalPrApproval, {
                ...ctx,
                releaseTrack: 'stable',
            }),
        ).resolves.toBe(false);
        expect(posthog.isFeatureEnabled).not.toHaveBeenCalled();
    });
});
