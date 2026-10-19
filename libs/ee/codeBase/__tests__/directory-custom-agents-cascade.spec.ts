/**
 * A directory's custom agents and knowledge add to the repository's instead
 * of replacing them; the same id (or knowledge path) replaces the inherited
 * entry. Fixture domain: an invented greenhouse-irrigation monorepo.
 */
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';

const agent = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `Agent ${id}`,
    enabled: true,
    instructions: `Review as ${id}.`,
    ...over,
});

function service() {
    const svc = Object.create(CodeBaseConfigService.prototype) as any;
    svc.DEFAULT_CONFIG = {
        automatedReviewActive: true,
        kodusConfigFileOverridesWebPreferences: false,
        ignorePaths: [],
    };
    svc.codeManagementService = {
        getTypeIntegration: jest.fn(async () => 'github'),
        getRepositoryContentFile: jest.fn(async () => null),
    };
    return svc as CodeBaseConfigService;
}

const REPO_KNOWLEDGE = [
    { path: 'docs/valves.md', kind: 'doc', linkedTo: [{ agentId: 'valves' }] },
    { path: 'docs/pumps.md', kind: 'doc', linkedTo: ['main-review'] },
];

const parameter = (directoryConfigs: Record<string, unknown> | undefined) =>
    ({
        id: 'global',
        name: 'Global',
        isSelected: true,
        configs: { ignorePaths: ['**/*.lock'] },
        repositories: [
            {
                id: 'repo-1',
                name: 'greenhouse',
                isSelected: true,
                configs: {
                    ignorePaths: ['dist/**'],
                    customAgents: [
                        agent('valves'),
                        agent('pumps'),
                        agent('sensors'),
                    ],
                    knowledge: REPO_KNOWLEDGE,
                },
                directories: directoryConfigs
                    ? [
                          {
                              id: 'dir-1',
                              name: 'zones',
                              path: '/apps/zones',
                              isSelected: true,
                              configs: directoryConfigs,
                          },
                      ]
                    : [],
            },
        ],
    }) as any;

const merge = (directoryConfigs?: Record<string, unknown>) =>
    service().getMergedCodeReviewConfigs(
        { organizationId: 'org-1', teamId: 'team-1' },
        { id: 'repo-1', name: 'greenhouse' },
        parameter(directoryConfigs),
        'main',
        [{ filename: 'apps/zones/drip.ts' } as any],
    );

const ids = (config: any) => config.customAgents.map((a: any) => a.id);

describe('custom agents at a directory', () => {
    it("adds the directory's agents to the repository's", async () => {
        const merged = await merge({ customAgents: [agent('drip')] });

        expect(merged.configLevel).toBe('directory');
        expect(ids(merged)).toEqual(['valves', 'pumps', 'sensors', 'drip']);
    });

    it('lets a directory agent with an inherited id replace it, in place', async () => {
        const merged = await merge({
            customAgents: [
                agent('drip'),
                agent('pumps', { instructions: 'Zone pumps only.' }),
            ],
        });

        expect(ids(merged)).toEqual(['valves', 'pumps', 'sensors', 'drip']);
        expect((merged.customAgents as any)[1].instructions).toBe(
            'Zone pumps only.',
        );
    });

    it('turns an inherited agent off through the same id', async () => {
        const merged = await merge({
            customAgents: [agent('sensors', { enabled: false })],
        });

        expect(
            (merged.customAgents as any[]).map((a) => [a.id, a.enabled]),
        ).toEqual([
            ['valves', true],
            ['pumps', true],
            ['sensors', false],
        ]);
    });

    it('adds knowledge the same way, a same path replacing the inherited item', async () => {
        const mine = {
            path: 'docs/pumps.md',
            kind: 'doc',
            linkedTo: [{ agentId: 'drip' }],
        };
        const extra = { path: 'docs/drip.md', kind: 'skill', linkedTo: [] };
        const merged = await merge({
            customAgents: [agent('drip')],
            knowledge: [mine, extra],
        });

        expect(merged.knowledge).toEqual([REPO_KNOWLEDGE[0], mine, extra]);
    });

    it("keeps the repository's lists when the directory sets none", async () => {
        const merged = await merge({ automatedReviewActive: false });

        expect(ids(merged)).toEqual(['valves', 'pumps', 'sensors']);
        expect(merged.knowledge).toEqual(REPO_KNOWLEDGE);
    });

    it('still replaces every other list whole', async () => {
        const merged = await merge({
            customAgents: [agent('drip')],
            ignorePaths: ['apps/zones/fixtures/**'],
        });

        expect(merged.ignorePaths).toEqual(['apps/zones/fixtures/**']);
    });
});
