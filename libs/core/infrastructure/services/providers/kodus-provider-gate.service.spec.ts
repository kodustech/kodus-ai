import { environment } from '@libs/ee/configs/environment';
import {
    KODUS_PROVIDER_ALPHA_ORGS_ENV,
    KodusProviderGate,
    parseAlphaOrgs,
} from './kodus-provider-gate.service';

/**
 * The private-alpha gate for the Kodus provider: cloud-only, then the
 * catalog + PostHog decision through FeatureGateService, with the org's
 * release track supplied — and closed on any failure.
 */
describe('KodusProviderGate', () => {
    let savedCloud: boolean;
    let savedAllow: string | undefined;
    beforeEach(() => {
        savedCloud = environment.API_CLOUD_MODE;
        (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = true;
        savedAllow = process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV];
        delete process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV];
    });
    afterEach(() => {
        (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = savedCloud;
        if (savedAllow === undefined) delete process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV];
        else process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV] = savedAllow;
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
        (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = false;
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

describe('KodusProviderGate — env allow-list ahead of PostHog', () => {
    it('parses `*` and comma-separated ids', () => {
        expect(parseAlphaOrgs('*')).toBe('*');
        expect(parseAlphaOrgs(' org-a, org-b ,')).toEqual(new Set(['org-a', 'org-b']));
        expect(parseAlphaOrgs(undefined)).toEqual(new Set());
    });

    it('lets a listed org through without asking the flag; others still ask', async () => {
        (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = true;
        process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV] = 'org-a';
        const isEnabled = jest.fn(async () => false);
        const gate = new KodusProviderGate({ isEnabled } as any, undefined);
        await expect(gate.isEnabledFor('org-a')).resolves.toBe(true);
        expect(isEnabled).not.toHaveBeenCalled();
        await expect(gate.isEnabledFor('org-b')).resolves.toBe(false);
        expect(isEnabled).toHaveBeenCalledTimes(1);
    });

    it('`*` never overrides the cloud-only rule', async () => {
        process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV] = '*';
        (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = false;
        const gate = new KodusProviderGate({ isEnabled: jest.fn() } as any, undefined);
        await expect(gate.isEnabledFor('org-a')).resolves.toBe(false);
    });
});
