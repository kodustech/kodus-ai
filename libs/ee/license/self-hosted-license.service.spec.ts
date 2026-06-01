import { SelfHostedLicenseService } from './self-hosted-license.service';

/**
 * Guard: the env var name the self-hosted license is read from is the
 * CUSTOMER-FACING standard `KODUS_LICENSE_KEY` — must not be renamed (our
 * test provisioning sets this exact var). A DB-stored key takes precedence
 * over env.
 */
describe('SelfHostedLicenseService.getLicenseKey', () => {
    const ENV_KEY = 'KODUS_LICENSE_KEY';
    let saved: string | undefined;

    beforeEach(() => {
        saved = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
    });
    afterEach(() => {
        if (saved === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = saved;
    });

    // DB lookup miss → falls through to env.
    const makeService = (dbValue: unknown = null) => {
        const orgParams = {
            findByKey: jest
                .fn()
                .mockResolvedValue(dbValue == null ? null : { configValue: dbValue }),
        };
        return new SelfHostedLicenseService(orgParams as any);
    };
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const getKey = (svc: SelfHostedLicenseService) =>
        (svc as any).getLicenseKey(orgTeam) as Promise<string | null>;

    it('reads the customer-facing KODUS_LICENSE_KEY from env', async () => {
        process.env.KODUS_LICENSE_KEY = 'customer-license-jwt';
        expect(await getKey(makeService())).toBe('customer-license-jwt');
    });

    it('prefers the DB-stored key over env', async () => {
        process.env.KODUS_LICENSE_KEY = 'env-loses';
        expect(await getKey(makeService({ key: 'db-wins' }))).toBe('db-wins');
    });

    it('returns null when neither DB nor env has a key', async () => {
        expect(await getKey(makeService())).toBeNull();
    });
});
