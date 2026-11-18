import { GetSecurityScansUseCase } from './get-security-scans.use-case';

const id = '507f1f77bcf86cd799439011';
const repository = { id: '123', platform: 'GITHUB', host: 'github.com' };
const config = (platform = 'GITHUB', host = 'github.com') => ({
    integration: { platform },
    configValue: [{ id: '123', http_url: `https://${host}/acme/repo` }],
});
function setup(configs = [config()]) {
    const scans = {
        failStale: jest.fn(),
        findRecent: jest.fn(async () => []),
        findById: jest.fn(async () => ({ organizationId: 'org', repository })),
    };
    const integrations = {
        findByOrganizationAndConfigKey: jest.fn(async () => configs),
    };
    return {
        scans,
        integrations,
        useCase: new GetSecurityScansUseCase(scans as any, integrations as any),
    };
}

describe('scan read scope', () => {
    it('filters by the full identity of an unambiguous assigned repository', async () => {
        const { useCase, scans } = setup();
        await useCase.list('org', ['123']);
        expect(scans.findRecent).toHaveBeenCalledWith('org', [repository], 20);
        await expect(useCase.get('org', id, ['123'])).resolves.toMatchObject({
            repository,
        });
    });
    it.each([
        [config(), config('GITLAB', 'gitlab.com')],
        [config('GITLAB', 'gitlab.a.io'), config('GITLAB', 'gitlab.b.io')],
        [config(), { ...config(), configValue: [{ id: '123' }] }],
    ])(
        'never treats an ambiguous legacy permission id as permission on another instance',
        async (...configs) => {
            const { useCase, scans } = setup(configs as any);
            await useCase.list('org', ['123']);
            expect(scans.findRecent).toHaveBeenCalledWith('org', [], 20);
            await expect(useCase.get('org', id, ['123'])).rejects.toThrow(
                'Security scan not found',
            );
        },
    );
    it('keeps organization-wide access without resolving legacy repository ids', async () => {
        const { useCase, integrations, scans } = setup();
        await useCase.list('org', undefined);
        expect(
            integrations.findByOrganizationAndConfigKey,
        ).not.toHaveBeenCalled();
        expect(scans.findRecent).toHaveBeenCalledWith('org', undefined, 20);
    });
});
