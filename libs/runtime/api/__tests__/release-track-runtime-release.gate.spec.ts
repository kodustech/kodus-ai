import { environment } from '@libs/ee/configs/environment/environment';
import { FeatureGateService } from '@libs/feature-gate/application/feature-gate.service';

import { ReleaseTrackRuntimeRelease } from '../infrastructure/release-track-runtime-release.gate';

jest.mock('@libs/ee/configs/environment/environment', () => ({ environment: { API_CLOUD_MODE: true } }));

const ORG = 'org-1';

const posthog = () => ({ isEnabled: true, capture: jest.fn(), isFeatureEnabled: jest.fn(), getFeatureFlag: jest.fn(), groupIdentify: jest.fn(), identify: jest.fn() });

const make = (org: { releaseTrack?: unknown } | null | Error, opts: { noOrgService?: boolean } = {}) => {
    const findOne = jest.fn(async () => {
        if (org instanceof Error) throw org;
        return org as any;
    });
    const logger = { warn: jest.fn() };
    const gate = new ReleaseTrackRuntimeRelease(opts.noOrgService ? undefined : ({ findOne } as any));
    (gate as any).logger = logger;
    return { gate, findOne, logger };
};

describe.each([
    ['cloud', true],
    ['self-hosted', false],
])('Runtime release gate on %s', (_name, cloud) => {
    let featureGateSpy: jest.SpyInstance;
    let provider: ReturnType<typeof posthog>;

    beforeEach(() => {
        (environment as any).API_CLOUD_MODE = cloud;
        featureGateSpy = jest.spyOn(FeatureGateService.prototype, 'isEnabled');
        provider = posthog();
        // A real catalog service with a spy PostHog provider exists in the process;
        // the Runtime decision must never reach it.
        new FeatureGateService(provider as any);
    });

    afterEach(() => {
        featureGateSpy.mockRestore();
        const calls = Object.values(provider).filter((v): v is jest.Mock => jest.isMockFunction(v));
        for (const fn of calls) expect(fn).not.toHaveBeenCalled();
    });

    it('an org on the alpha track may use the Runtime, read from its stored track', async () => {
        const { gate, findOne } = make({ releaseTrack: 'alpha' });
        await expect(gate.isEnabledFor(ORG)).resolves.toBe(true);
        expect(findOne).toHaveBeenCalledWith({ uuid: ORG });
        expect(featureGateSpy).not.toHaveBeenCalled();
    });

    it('an org on the beta or stable track may not', async () => {
        await expect(make({ releaseTrack: 'beta' }).gate.isEnabledFor(ORG)).resolves.toBe(false);
        await expect(make({ releaseTrack: 'stable' }).gate.isEnabledFor(ORG)).resolves.toBe(false);
        expect(featureGateSpy).not.toHaveBeenCalled();
    });

    it('no org id is a no, without reading anything', async () => {
        const { gate, findOne } = make({ releaseTrack: 'alpha' });
        await expect(gate.isEnabledFor(undefined)).resolves.toBe(false);
        expect(findOne).not.toHaveBeenCalled();
    });

    it('a track that cannot be read is a no, logged once per org', async () => {
        const failing = make(new Error('db down'));
        await expect(failing.gate.isEnabledFor(ORG)).resolves.toBe(false);
        await expect(failing.gate.isEnabledFor(ORG)).resolves.toBe(false);
        expect(failing.logger.warn).toHaveBeenCalledTimes(1);

        const missing = make(null);
        await expect(missing.gate.isEnabledFor(ORG)).resolves.toBe(false);
        expect(missing.logger.warn).toHaveBeenCalledTimes(1);

        const unknown = make({ releaseTrack: 'internal' });
        await expect(unknown.gate.isEnabledFor(ORG)).resolves.toBe(false);
        expect(unknown.logger.warn).toHaveBeenCalledTimes(1);

        const noService = make(null, { noOrgService: true });
        await expect(noService.gate.isEnabledFor(ORG)).resolves.toBe(false);
        await expect(noService.gate.isEnabledFor('org-2')).resolves.toBe(false);
        expect(noService.logger.warn).toHaveBeenCalledTimes(1);
    });
});
