import * as yaml from 'js-yaml';

import { buildKodusConfigCentralizedMutationRequest } from '../kodus-config-centralized-pr.builder';
import type { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';

const buildServiceMock = (): Pick<
    CentralizedConfigPrService,
    'buildDirectoryGroupConfigPath' | 'buildDirectoryGroupRulesPath' | 'buildCentralizedPath'
> => ({
    buildDirectoryGroupConfigPath: jest
        .fn()
        .mockImplementation(
            (repositoryFolder: string, groupFolderName: string) =>
                `${repositoryFolder}/${groupFolderName}/kodus-config.yml`,
        ),
    buildDirectoryGroupRulesPath: jest
        .fn()
        .mockImplementation(
            (
                repositoryFolder: string,
                groupFolderName: string,
                rulesDirectory: string,
                fileName: string,
            ) =>
                `${repositoryFolder}/${groupFolderName}/.kody-rules/${rulesDirectory}/${fileName}`,
        ),
    buildCentralizedPath: jest
        .fn()
        .mockImplementation(({ repositoryFolder, relativePath }) =>
            repositoryFolder === 'global'
                ? relativePath
                : `${repositoryFolder}/${relativePath}`,
        ),
});

const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' };

describe('buildKodusConfigCentralizedMutationRequest — directory group flow', () => {
    it('emits a single upsert at the encoded folder when paths are unchanged', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            folders: [{ path: 'app/api' }, { path: 'app/web' }],
            configFileContent: { version: '1' },
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({
            path: 'repo-1-name/app%2Fapi&app%2Fweb/kodus-config.yml',
            operation: 'upsert',
        });
        const parsed = yaml.load(files[0].content) as any;
        expect(parsed).toEqual({ version: '1' });
        expect(files.some((f: any) => f.path.includes('folders.yml'))).toBe(false);
    });

    it('emits upsert(new) + delete(old config + old rules) when paths change', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            folders: [{ path: 'app/api' }, { path: 'app/web' }],
            previousFolders: [{ path: 'app/api' }],
            previousRulesFileNames: {
                review: ['no-console.yml', 'naming.yml'],
                memories: ['style-guide.yml'],
            },
            configFileContent: { version: '1' },
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        const paths = files.map((f: any) => `${f.operation} ${f.path}`).sort();
        expect(paths).toEqual([
            'delete repo-1-name/app%2Fapi/.kody-rules/memories/style-guide.yml',
            'delete repo-1-name/app%2Fapi/.kody-rules/review/naming.yml',
            'delete repo-1-name/app%2Fapi/.kody-rules/review/no-console.yml',
            'delete repo-1-name/app%2Fapi/kodus-config.yml',
            'upsert repo-1-name/app%2Fapi&app%2Fweb/kodus-config.yml',
        ]);
    });

    it('moves rule files to the new folder (upsert+delete) when content is provided on a rename', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            folders: [{ path: 'app/api' }, { path: 'app/web' }],
            previousFolders: [{ path: 'app/api' }],
            previousRulesFileNames: {
                review: [
                    { fileName: 'no-console.yml', content: 'title: no-console\n' },
                ],
                memories: [
                    { fileName: 'style.yml', content: 'title: style\n' },
                ],
            },
            configFileContent: null,
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        const paths = files.map((f: any) => `${f.operation} ${f.path}`).sort();
        expect(paths).toEqual([
            'delete repo-1-name/app%2Fapi/.kody-rules/memories/style.yml',
            'delete repo-1-name/app%2Fapi/.kody-rules/review/no-console.yml',
            'delete repo-1-name/app%2Fapi/kodus-config.yml',
            'upsert repo-1-name/app%2Fapi&app%2Fweb/.kody-rules/memories/style.yml',
            'upsert repo-1-name/app%2Fapi&app%2Fweb/.kody-rules/review/no-console.yml',
        ]);
        const upsertReview = files.find((f: any) =>
            f.path.endsWith('review/no-console.yml') &&
            f.operation === 'upsert',
        );
        expect(upsertReview.content).toBe('title: no-console\n');
    });

    it('deletes the current folder when content is cleared and paths are unchanged', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            folders: [{ path: 'app/api' }],
            configFileContent: null,
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        expect(files).toEqual([
            {
                path: 'repo-1-name/app%2Fapi/kodus-config.yml',
                operation: 'delete',
            },
        ]);
    });

    it('still emits the rename-delete even when the new content is empty', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            folders: [{ path: 'app/api' }, { path: 'app/web' }],
            previousFolders: [{ path: 'app/api' }],
            configFileContent: null,
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        const paths = files.map((f: any) => `${f.operation} ${f.path}`).sort();
        expect(paths).toEqual([
            'delete repo-1-name/app%2Fapi/kodus-config.yml',
        ]);
    });

    it('uses a single-segment folder name for a single-path group', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            folders: [{ path: 'app/api' }],
            configFileContent: { version: '1' },
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('repo-1-name/app%2Fapi/kodus-config.yml');
        expect(files[0].path).not.toContain('&');
    });

    it('routes non-group (legacy directoryPath) requests through the flat path branch', () => {
        const service = buildServiceMock();
        const req = buildKodusConfigCentralizedMutationRequest({
            centralizedConfigPrService: service as any,
            organizationAndTeamData: orgAndTeam,
            repositoryId: 'repo-1',
            directoryPath: 'apps/web',
            configFileContent: { version: '1' },
            title: 't',
            description: 'd',
            commitMessage: 'c',
            sourceBranchPrefix: 'kodus-test',
        });

        const files = (req.files as any)({ repositoryFolder: 'repo-1-name' });
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('repo-1-name/apps/web/kodus-config.yml');
        expect(service.buildDirectoryGroupConfigPath).not.toHaveBeenCalled();
    });
});

// #1688: code review settings and custom PR messages arrive as request bodies
// with `@Type(() => Dto)` nested classes; these prove both call sites reach
// the DTO-safe yaml dump.
class SeverityLimitsDto {
    high: number;
}

function configWithNestedDto() {
    const severityLimits = new SeverityLimitsDto();
    severityLimits.high = 5;
    return { languageResultPrompt: 'en-US', severityLimits } as any;
}

const dtoPrService = {
    buildCentralizedPath: ({ relativePath }: { relativePath: string }) =>
        `my-repo/${relativePath}`,
    buildDirectoryGroupConfigPath: (
        repositoryFolder: string,
        folderName: string,
    ) => `${repositoryFolder}/${folderName}/kodus-config.yml`,
} as any;

const dtoBase = {
    centralizedConfigPrService: dtoPrService,
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repositoryId: 'repo-1',
    title: 't',
    description: 'd',
    commitMessage: 'c',
    sourceBranchPrefix: 'kodus-config',
};

function upsertContent(request: any) {
    const ops = request.files({ repositoryFolder: 'my-repo' });
    const upsert = ops.find((op: any) => op.operation === 'upsert');
    expect(upsert).toBeDefined();
    return upsert.content;
}

describe('buildKodusConfigCentralizedMutationRequest — DTO payloads', () => {
    it('repository-scope config dumps a nested DTO instance', () => {
        const request = buildKodusConfigCentralizedMutationRequest({
            ...dtoBase,
            configFileContent: configWithNestedDto(),
        } as any);

        expect(yaml.load(upsertContent(request))).toEqual({
            languageResultPrompt: 'en-US',
            severityLimits: { high: 5 },
        });
    });

    it('directory-group config dumps a nested DTO instance', () => {
        const request = buildKodusConfigCentralizedMutationRequest({
            ...dtoBase,
            folders: [{ path: 'src' }],
            configFileContent: configWithNestedDto(),
        } as any);

        expect(yaml.load(upsertContent(request))).toEqual({
            languageResultPrompt: 'en-US',
            severityLimits: { high: 5 },
        });
    });

    it('a plain payload is written exactly as js-yaml would have written it', () => {
        const plain = { languageResultPrompt: 'en-US', ignorePaths: ['dist'] };

        const request = buildKodusConfigCentralizedMutationRequest({
            ...dtoBase,
            configFileContent: plain,
        } as any);

        expect(upsertContent(request)).toBe(yaml.dump(plain));
    });
});
