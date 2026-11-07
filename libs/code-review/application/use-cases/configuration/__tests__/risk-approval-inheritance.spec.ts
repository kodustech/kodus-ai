import * as yaml from 'js-yaml';
import { GetCodeReviewParameterUseCase } from '../get-code-review-parameter.use-case';
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

const org = { organizationId: 'org', teamId: 'team' };
const build = (file: object, global: object, directory?: object) => {
    const stored = {
        id: 'global',
        name: 'Global',
        isSelected: true,
        configs: global,
        repositories: [
            {
                id: 'repo',
                name: 'api',
                isSelected: true,
                configs: { kodusConfigFileOverridesWebPreferences: true },
                directories: directory
                    ? [
                          {
                              id: 'dir',
                              name: 'Source',
                              isSelected: true,
                              folders: [
                                  { id: 'src', name: 'src', path: 'src' },
                              ],
                              configs: directory,
                          },
                      ]
                    : [],
            },
        ],
    };
    const code = {
        getTypeIntegration: jest.fn().mockResolvedValue(PlatformType.GITHUB),
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
        getRepositoryContentFile: jest
            .fn()
            .mockResolvedValue({ data: { content: yaml.dump(file) } }),
    };
    const base = new CodeBaseConfigService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        code as any,
        {} as any,
        {} as any,
        {} as any,
    );
    const get = new GetCodeReviewParameterUseCase(
        {
            findByKey: async () => ({
                toObject: () => ({
                    configValue: stored,
                    createdAt: new Date('2026-01-01'),
                }),
            }),
        } as any,
        base,
        {} as any,
        {
            buildConfigKey: () => 'key',
            getReference: async () => null,
            getMultipleReferences: async () => new Map(),
        } as any,
    );
    return { stored, base, get };
};

it('returns the same directory approval conditions that the review actually uses, including the repository YAML', async () => {
    const { stored, base, get } = build(
        { approvalLabels: ['ready'] },
        {
            pullRequestApprovalActive: true,
            approvalPolicies: [
                {
                    id: 'legacy-approval',
                    name: 'Existing approval policy',
                    enabled: true,
                },
            ],
        },
        { approvalAuthors: ['build-bot'] },
    );
    const effective = await base.getMergedCodeReviewConfigs(
        org,
        { id: 'repo', name: 'api' },
        stored as any,
        'main',
        [{ filename: 'src/file.ts' }] as any,
    );
    const view = await get.execute(
        { organization: { uuid: 'org' } } as any,
        'team',
        { skipAuthorization: true, includeFileOverlay: true },
    );
    expect(effective.approvalPolicies).toEqual([
        expect.objectContaining({ labels: ['ready'], authors: ['build-bot'] }),
    ]);
    expect(
        view.configValue.repositories[0].directories[0].configs.approvalPolicies
            .value,
    ).toEqual(effective.approvalPolicies);
    expect(stored.repositories[0].directories[0].configs).toEqual({
        approvalAuthors: ['build-bot'],
    });
});

it.each([
    [
        { riskAssessmentActive: false, pullRequestApprovalActive: true },
        { approvalRiskActive: true },
    ],
    [
        { approvalRiskActive: true, pullRequestApprovalActive: true },
        { pullRequestApprovalActive: false },
    ],
    [{ riskAssessmentActive: true }, { pullRequestApprovalActive: false }],
])(
    'shows the same effective risk state as the review for old and new file settings',
    async (global, file) => {
        const { stored, base, get } = build(file, global);
        const effective = await base.getMergedCodeReviewConfigs(
            org,
            { id: 'repo', name: 'api' },
            stored as any,
            'main',
            [],
        );
        const view = await get.execute(
            { organization: { uuid: 'org' } } as any,
            'team',
            { skipAuthorization: true, includeFileOverlay: true },
        );
        expect(
            view.configValue.repositories[0].configs.riskAssessmentActive.value,
        ).toBe(effective.riskAssessmentActive);
    },
);

it('keeps the repository visible when its YAML conflicts with inherited named policies', async () => {
    const { get } = build(
        { approvalLabels: ['ready'] },
        {
            approvalPolicies: [{ id: 'docs', name: 'Docs', enabled: true }],
        },
    );
    const view = await get.execute(
        { organization: { uuid: 'org' } } as any,
        'team',
        { skipAuthorization: true, includeFileOverlay: true },
    );
    expect(view.configValue.repositories).toHaveLength(1);
    expect(view.configValue.repositories[0].kodusConfigFile).toMatchObject({
        status: 'unavailable',
        error: expect.stringContaining(
            'Legacy approval filters cannot scope named policies',
        ),
    });
});
