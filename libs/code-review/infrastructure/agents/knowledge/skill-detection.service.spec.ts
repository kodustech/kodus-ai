import { skillMarkdown } from './knowledge.fixtures';
import {
    matchSkillCandidates,
    MAX_DETECTED_SKILLS,
    RepositorySkillDetectionService,
} from './skill-detection.service';

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { id: 'repo-1', name: 'ledger-service' };

describe('matchSkillCandidates', () => {
    it('keeps only the known skill locations', () => {
        expect(
            matchSkillCandidates([
                '.claude/skills/ledger-errors/SKILL.md',
                '.claude/skills/ledger-errors/references/codes.md',
                '.claude/skills/nested/deeper/SKILL.md',
                '.claude/agents/migration-reviewer.md',
                '.agents/skills/money/SKILL.md',
                '.github/skills/release-notes/SKILL.md',
                'docs/SKILL.md',
                'src/ledger.ts',
            ]),
        ).toEqual([
            '.agents/skills/money/SKILL.md',
            '.claude/agents/migration-reviewer.md',
            '.claude/skills/ledger-errors/SKILL.md',
            '.github/skills/release-notes/SKILL.md',
        ]);
    });

    it('bounds the number of candidates', () => {
        const paths = Array.from(
            { length: MAX_DETECTED_SKILLS + 10 },
            (_, i) => `.claude/skills/s${i}/SKILL.md`,
        );
        expect(matchSkillCandidates(paths)).toHaveLength(MAX_DETECTED_SKILLS);
    });
});

describe('RepositorySkillDetectionService', () => {
    const contents: Record<string, string> = {
        '.claude/skills/ledger-errors/SKILL.md': skillMarkdown(
            'ledger-errors',
            'How the ledger team raises errors.',
        ),
        '.claude/agents/migration-reviewer.md': skillMarkdown(
            'migration-reviewer',
            'Checks migrations.',
        ),
        '.github/skills/release-notes/SKILL.md': skillMarkdown(
            'Release_Notes',
            'Bad name.',
        ),
    };

    const build = () => {
        const codeManagementService = {
            getDefaultBranch: jest.fn().mockResolvedValue('trunk'),
            getRepositoryAllFiles: jest.fn().mockResolvedValue(
                [...Object.keys(contents), 'src/ledger.ts'].map((path) => ({
                    path,
                })),
            ),
            getRepositoryContentFile: jest.fn(async ({ file }) => ({
                data: {
                    content: Buffer.from(contents[file.filename]).toString(
                        'base64',
                    ),
                    encoding: 'base64',
                },
            })),
        };
        const service = new RepositorySkillDetectionService(
            codeManagementService as any,
        );
        return { service, codeManagementService };
    };

    it('lists skills on the default branch with their frontmatter', async () => {
        const { service, codeManagementService } = build();

        const detected = await service.detect({
            organizationAndTeamData,
            repository,
        });

        expect(detected).toEqual([
            {
                path: '.claude/agents/migration-reviewer.md',
                file: '.claude/agents/migration-reviewer.md',
                source: '.claude/agents',
                valid: true,
                name: 'migration-reviewer',
                description: 'Checks migrations.',
            },
            {
                path: '.claude/skills/ledger-errors',
                file: '.claude/skills/ledger-errors/SKILL.md',
                source: '.claude/skills',
                valid: true,
                name: 'ledger-errors',
                description: 'How the ledger team raises errors.',
            },
            expect.objectContaining({
                path: '.github/skills/release-notes',
                source: '.github/skills',
                valid: false,
                errors: [expect.stringMatching(/name/)],
            }),
        ]);
        expect(
            codeManagementService.getRepositoryAllFiles,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                filters: expect.objectContaining({ branch: 'trunk' }),
            }),
        );
        for (const [args] of codeManagementService.getRepositoryContentFile.mock
            .calls) {
            expect(args.pullRequest).toEqual({
                head: { ref: 'trunk' },
                base: { ref: 'trunk' },
            });
        }
    });

    it('returns an empty list when the provider fails', async () => {
        const { service, codeManagementService } = build();
        codeManagementService.getDefaultBranch.mockRejectedValue(
            new Error('provider down'),
        );

        await expect(
            service.detect({ organizationAndTeamData, repository }),
        ).resolves.toEqual([]);
    });
});
