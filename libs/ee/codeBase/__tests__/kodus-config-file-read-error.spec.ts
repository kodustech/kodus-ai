import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { KodusConfigFileReadError } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';

const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { status });

function service(
    read: jest.Mock,
    defaultBranch: jest.Mock = jest.fn().mockResolvedValue('main'),
) {
    const svc = Object.create(CodeBaseConfigService.prototype) as any;
    svc.logger = { warn: jest.fn() };
    svc.DEFAULT_CONFIG = { showStatusFeedback: true };
    svc.codeManagementService = {
        getTypeIntegration: jest.fn(async () => 'github'),
        getRepositoryContentFile: read,
        getDefaultBranch: defaultBranch,
    };
    return svc as CodeBaseConfigService;
}

const read = (
    svc: CodeBaseConfigService,
    throwOnReadError?: boolean,
    defaultBranch = 'main',
) =>
    svc.getKodusConfigFile({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        defaultBranch,
        throwOnReadError,
    });

describe('kodus-config.yml read failures', () => {
    it('asks the provider to throw and wraps a transient failure when the caller opts in', async () => {
        const providerError = httpError(502);
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

    it('wraps a transient failure of the default branch lookup, asked in strict mode', async () => {
        const getContent = jest.fn();
        const getDefaultBranch = jest.fn().mockRejectedValue(httpError(503));

        const failure = await read(
            service(getContent, getDefaultBranch),
            true,
            '',
        ).catch((e) => e);

        expect(getDefaultBranch).toHaveBeenCalledWith(
            expect.objectContaining({ strict: true }),
        );
        expect(failure).toBeInstanceOf(KodusConfigFileReadError);
        expect(getContent).not.toHaveBeenCalled();
    });

    it('leaves a lasting default branch failure as a plain error', async () => {
        const getDefaultBranch = jest.fn().mockRejectedValue(httpError(404));

        const failure = await read(
            service(jest.fn(), getDefaultBranch),
            true,
            '',
        ).catch((e) => e);

        expect(failure).not.toBeInstanceOf(KodusConfigFileReadError);
    });
});
