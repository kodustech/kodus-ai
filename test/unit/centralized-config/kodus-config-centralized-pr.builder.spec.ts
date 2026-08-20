/**
 * Call-site coverage for #1688 beyond the rule payload.
 *
 * `buildKodusConfigCentralizedMutationRequest` writes `kodus-config.yml` for
 * code review settings and custom PR messages, both of which arrive as
 * request bodies with `@Type(() => Dto)` nested classes. Testing the dump
 * helper on its own proves the helper works; these prove these two call sites
 * actually reach it.
 */
import * as yaml from 'js-yaml';

import { buildKodusConfigCentralizedMutationRequest } from '@libs/centralized-config/utils/kodus-config-centralized-pr.builder';

class SeverityLimitsDto {
    high: number;
}

function configWithNestedDto() {
    const severityLimits = new SeverityLimitsDto();
    severityLimits.high = 5;
    return { languageResultPrompt: 'en-US', severityLimits } as any;
}

const prService = {
    buildCentralizedPath: ({ relativePath }: { relativePath: string }) =>
        `my-repo/${relativePath}`,
    buildDirectoryGroupConfigPath: (
        repositoryFolder: string,
        folderName: string,
    ) => `${repositoryFolder}/${folderName}/kodus-config.yml`,
} as any;

const base = {
    centralizedConfigPrService: prService,
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
            ...base,
            configFileContent: configWithNestedDto(),
        } as any);

        expect(yaml.load(upsertContent(request))).toEqual({
            languageResultPrompt: 'en-US',
            severityLimits: { high: 5 },
        });
    });

    it('directory-group config dumps a nested DTO instance', () => {
        const request = buildKodusConfigCentralizedMutationRequest({
            ...base,
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
            ...base,
            configFileContent: plain,
        } as any);

        expect(upsertContent(request)).toBe(yaml.dump(plain));
    });
});
