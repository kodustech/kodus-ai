import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { KodusConfigFileReadError } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';

function service(read: jest.Mock) {
    const svc = Object.create(CodeBaseConfigService.prototype) as any;
    svc.logger = { warn: jest.fn() };
    svc.DEFAULT_CONFIG = { showStatusFeedback: true };
    svc.codeManagementService = {
        getTypeIntegration: jest.fn(async () => 'github'),
        getRepositoryContentFile: read,
    };
    return svc as CodeBaseConfigService;
}

const read = (svc: CodeBaseConfigService, throwOnReadError?: boolean) =>
    svc.getKodusConfigFile({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        defaultBranch: 'main',
        throwOnReadError,
    });

describe('kodus-config.yml read failures', () => {
    it('asks the provider to throw and wraps its failure when the caller opts in', async () => {
        const providerError = new Error('502 Bad Gateway');
        const getContent = jest.fn().mockRejectedValue(providerError);

        const failure = await read(service(getContent), true).catch((e) => e);

        expect(getContent).toHaveBeenCalledWith(
            expect.objectContaining({ throwOnReadError: true }),
        );
        expect(failure).toBeInstanceOf(KodusConfigFileReadError);
        expect(failure.cause).toBe(providerError);
    });

    it('reads a missing file as no file when the caller opts in', async () => {
        const getContent = jest.fn().mockResolvedValue(null);

        await expect(read(service(getContent), true)).resolves.toBeUndefined();
    });

    it('does not ask the provider to throw by default', async () => {
        const getContent = jest.fn().mockResolvedValue(null);

        await read(service(getContent));

        expect(getContent).toHaveBeenCalledWith(
            expect.objectContaining({ throwOnReadError: false }),
        );
    });
});
