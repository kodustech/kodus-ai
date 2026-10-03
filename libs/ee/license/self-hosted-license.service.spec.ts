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

/**
 * Self-hosted has no Kodus-funded managed trial credits, so credit
 * consumption must always allow — the licensed seat model gates reviews
 * instead. Returning allowed:false here would block self-hosted reviews.
 */
describe('SelfHostedLicenseService.consumeTrialReviewCredit', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const makeService = () =>
        new SelfHostedLicenseService({ findByKey: jest.fn() } as any);

    it('always allows on self-hosted', async () => {
        const result = await makeService().consumeTrialReviewCredit(orgTeam);
        expect(result).toEqual({ allowed: true, reason: 'SELF_HOSTED' });
    });

    it('allows regardless of the usageKey', async () => {
        const result = await makeService().consumeTrialReviewCredit(
            orgTeam,
            'repo-1:7',
        );
        expect(result.allowed).toBe(true);
    });
});

/**
 * The key is stored per organization, so each organization is validated
 * against its own key, including right after another one validated.
 */
describe('SelfHostedLicenseService.validateOrganizationLicense', () => {
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

    const makeService = (keys: Record<string, string>) => {
        const orgParams = {
            findByKey: jest.fn(async (_key: string, orgTeam: any) =>
                keys[orgTeam.organizationId]
                    ? { configValue: { key: keys[orgTeam.organizationId] } }
                    : null,
            ),
        };
        const svc = new SelfHostedLicenseService(orgParams as any);
        (svc as any).verifyAndDecode = jest.fn(() => ({
            plan: 'enterprise',
            seats: 10,
            exp: Math.floor(Date.now() / 1000) + 3600,
        }));
        return { svc, orgParams };
    };
    const org = (organizationId: string) =>
        ({ organizationId, teamId: `${organizationId}-team` }) as any;

    it('validates each organization against its own key', async () => {
        const { svc } = makeService({ 'org-licensed': 'jwt' });

        expect(
            (await svc.validateOrganizationLicense(org('org-licensed'))).valid,
        ).toBe(true);
        expect(
            (await svc.validateOrganizationLicense(org('org-without-key')))
                .valid,
        ).toBe(false);
    });

    it('reuses a result for the same organization', async () => {
        const { svc, orgParams } = makeService({ 'org-licensed': 'jwt' });

        await svc.validateOrganizationLicense(org('org-licensed'));
        await svc.validateOrganizationLicense(org('org-licensed'));

        expect(orgParams.findByKey).toHaveBeenCalledTimes(1);
    });

    it('validates every organization when the key comes from env', async () => {
        process.env.KODUS_LICENSE_KEY = 'env-jwt';
        const { svc } = makeService({});

        expect((await svc.validateOrganizationLicense(org('a'))).valid).toBe(
            true,
        );
        expect((await svc.validateOrganizationLicense(org('b'))).valid).toBe(
            true,
        );
    });
});
