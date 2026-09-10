import { environment } from '@libs/ee/configs/environment';
import { KodusProviderGate } from './kodus-provider-gate.service';

/**
 * The private-alpha gate for the Kodus provider: cloud-only, then the
 * catalog + PostHog decision through FeatureGateService, with the org's
 * release track supplied — and closed on any failure.
 */
describe('KodusProviderGate', () => {
    const cloud = environment as { API_CLOUD_MODE: boolean };
    let savedCloud: boolean;
    beforeEach(() => {
        savedCloud = cloud.API_CLOUD_MODE;
        cloud.API_CLOUD_MODE = true;
    });
    afterEach(() => {
        cloud.API_CLOUD_MODE = savedCloud;
    });

    const build = (over: {
        enabled?: boolean | Error;
        track?: string | Error;
        withOrgService?: boolean;
    } = {}) => {
        const isEnabled = jest.fn(async () => {
            if (over.enabled instanceof Error) throw over.enabled;
            return over.enabled ?? true;
        });
        const getReleaseTrack = jest.fn(async () => {
            if (over.track instanceof Error) throw over.track;
            return over.track ?? 'alpha';
        });
        const gate = new KodusProviderGate(
            { isEnabled } as any,
            over.withOrgService === false ? undefined : ({ getReleaseTrack } as any),
        );
        return { gate, isEnabled, getReleaseTrack };
    };

    it('asks the feature gate for `kodus-provider` with the org as identifier + group and its release track', async () => {
        const { gate, isEnabled, getReleaseTrack } = build({ track: 'alpha' });
        await expect(gate.isEnabledFor('org-1')).resolves.toBe(true);
        expect(getReleaseTrack).toHaveBeenCalledWith('org-1');
        expect(isEnabled).toHaveBeenCalledWith('kodus-provider', {
            identifier: 'org-1',
            organizationAndTeamData: { organizationId: 'org-1' },
            releaseTrack: 'alpha',
        });
    });

    it('is off when the flag says so', async () => {
        const { gate } = build({ enabled: false });
        await expect(gate.isEnabledFor('org-1')).resolves.toBe(false);
    });

    it('is off on a self-hosted install without asking the flag', async () => {
        cloud.API_CLOUD_MODE = false;
        const { gate, isEnabled } = build();
        await expect(gate.isEnabledFor('org-1')).resolves.toBe(false);
        expect(isEnabled).not.toHaveBeenCalled();
    });

    it('is off without an organization', async () => {
        const { gate, isEnabled } = build();
        await expect(gate.isEnabledFor(undefined)).resolves.toBe(false);
        expect(isEnabled).not.toHaveBeenCalled();
    });

    it('fails closed when the flag check or the track lookup throws', async () => {
        await expect(
            build({ enabled: new Error('posthog down') }).gate.isEnabledFor('org-1'),
        ).resolves.toBe(false);
        await expect(
            build({ track: new Error('db down') }).gate.isEnabledFor('org-1'),
        ).resolves.toBe(false);
    });

    it('passes no track when the organization service is absent (catalog then treats it as beta → alpha denied)', async () => {
        const { gate, isEnabled } = build({ withOrgService: false });
        await gate.isEnabledFor('org-1');
        expect(isEnabled).toHaveBeenCalledWith(
            'kodus-provider',
            expect.objectContaining({ releaseTrack: undefined }),
        );
    });
});
