/**
 * kodus-config.yml with keys that are configured only in the app
 * (customAgents, knowledge): the rest of the file still applies, and the
 * merged config names the dropped keys so the review can warn about them.
 * Fixture domain: an invented beekeeping-inventory service.
 */
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';

const FILE = `version: 1.2
automatedReviewActive: false
customAgents:
  - name: Hive audit
    instructions: Every hive record needs an inspection date.
knowledge:
  - path: docs/hives.md
`;

function service(fileContent: string | null) {
    const svc = Object.create(CodeBaseConfigService.prototype) as any;
    svc.DEFAULT_CONFIG = {
        automatedReviewActive: true,
        kodusConfigFileOverridesWebPreferences: false,
    };
    svc.codeManagementService = {
        getTypeIntegration: jest.fn(async () => 'github'),
        getRepositoryContentFile: jest.fn(async () =>
            fileContent === null ? null : { data: { content: fileContent } },
        ),
    };
    return svc as CodeBaseConfigService;
}

const merge = (svc: CodeBaseConfigService, fileWins = true) =>
    svc.getMergedCodeReviewConfigs(
        { organizationId: 'org-1', teamId: 'team-1' },
        { id: 'repo-1', name: 'hive-inventory' },
        {
            id: 'global',
            name: 'Global',
            isSelected: true,
            configs: {},
            repositories: [
                {
                    id: 'repo-1',
                    name: 'hive-inventory',
                    isSelected: true,
                    configs: {
                        kodusConfigFileOverridesWebPreferences: fileWins,
                    },
                },
            ],
        } as any,
        'main',
        [],
    );

describe('kodus-config.yml with app-only keys', () => {
    it('applies the rest of the file and names the dropped keys', async () => {
        const merged = await merge(service(FILE));

        expect(merged.automatedReviewActive).toBe(false);
        expect((merged as any).customAgents).toBeUndefined();
        expect((merged as any).knowledge).toBeUndefined();
        expect(merged.kodusConfigFileDroppedKeys).toEqual(
            expect.arrayContaining(['customAgents', 'knowledge']),
        );
    });

    it('names nothing for a file with only known settings', async () => {
        const merged = await merge(service('automatedReviewActive: false\n'));

        expect(merged.automatedReviewActive).toBe(false);
        expect(merged.kodusConfigFileDroppedKeys).toBeUndefined();
    });

    it('names nothing when the file is not read (web preferences win)', async () => {
        const merged = await merge(service(FILE), false);

        expect(merged.automatedReviewActive).toBe(true);
        expect(merged.kodusConfigFileDroppedKeys).toBeUndefined();
    });
});
