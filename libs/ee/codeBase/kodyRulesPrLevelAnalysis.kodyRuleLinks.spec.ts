import { KodyRulesPrLevelAnalysisService } from './kodyRulesPrLevelAnalysis.service';

describe('KodyRulesPrLevelAnalysisService — Kody Rule link generation', () => {
    let service: KodyRulesPrLevelAnalysisService;
    let kodyRulesService: { findById: jest.Mock };

    const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };
    const PR_NUMBER = 42;

    const buildLinks = (foundIds: string[], content: string) =>
        (service as any).buildKodyRuleLinkAndRepalceIds(
            foundIds,
            content,
            orgData,
            PR_NUMBER,
        );

    beforeEach(() => {
        process.env.API_USER_INVITE_BASE_URL = 'https://app.kodus.io';

        kodyRulesService = { findById: jest.fn() };

        service = new KodyRulesPrLevelAnalysisService(
            kodyRulesService as any,
            {} as any, // tokenChunkingService
            {} as any, // promptRunnerService
            {} as any, // observabilityService
            {} as any, // externalReferenceLoaderService
            {} as any, // fileContextAugmentationService
            {} as any, // kodyRuleDependencyService
        );
    });

    afterEach(() => {
        delete process.env.API_USER_INVITE_BASE_URL;
    });

    it('returns content unchanged when there are no rule IDs', async () => {
        const content = 'Some review text without any rules.';
        const result = await buildLinks([], content);
        expect(result).toBe(content);
        expect(kodyRulesService.findById).not.toHaveBeenCalled();
    });

    it('replaces a global-scoped rule ID with a markdown link to the global settings page', async () => {
        const ruleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        kodyRulesService.findById.mockResolvedValue({
            uuid: ruleId,
            title: 'Avoid console log',
            repositoryId: 'global',
        });

        const content = `This violates rule ${ruleId} in your file.`;
        const result = await buildLinks([ruleId], content);

        // teamId is appended so directory-scoped rules resolve correctly
        // on the settings page (was the David B / quintoandar bug).
        const expectedLink = `[Avoid console log](https://app.kodus.io/settings/code-review/global/kody-rules/${ruleId}?teamId=team-1)`;
        expect(result).toBe(`This violates rule ${expectedLink} in your file.`);
    });

    it('escapes special markdown characters in the rule title', async () => {
        const ruleId = 'cccccccc-dddd-eeee-ffff-000000000000';
        kodyRulesService.findById.mockResolvedValue({
            uuid: ruleId,
            title: 'Avoid console.log() and `eval`',
            repositoryId: 'global',
        });

        const content = `Rule: ${ruleId}`;
        const result = await buildLinks([ruleId], content);

        // Dot, parens, and backticks are escaped so they render as literals,
        // not as markdown syntax that breaks the link.
        expect(result).toContain(
            '[Avoid console\\.log\\(\\) and \\`eval\\`]',
        );
    });

    it('uses the repository-scoped URL when the rule has a non-global repositoryId', async () => {
        const ruleId = '11111111-2222-3333-4444-555555555555';
        kodyRulesService.findById.mockResolvedValue({
            uuid: ruleId,
            title: 'No magic numbers',
            repositoryId: 'repo-uuid-xyz',
        });

        const content = `Issue: ${ruleId}`;
        const result = await buildLinks([ruleId], content);

        expect(result).toContain(
            `(https://app.kodus.io/settings/code-review/repo-uuid-xyz/kody-rules/${ruleId}?teamId=team-1)`,
        );
        expect(result).toContain('[No magic numbers]');
    });

    it('renders 3 distinct links for 3 distinct rule IDs', async () => {
        const ids = [
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
            '00000000-0000-0000-0000-000000000003',
        ];
        kodyRulesService.findById.mockImplementation(async (id: string) => ({
            uuid: id,
            title: `Rule ${id.slice(-1)}`,
            repositoryId: 'global',
        }));

        const content = `Rules violated: ${ids[0]}, ${ids[1]}, ${ids[2]}`;
        const result = await buildLinks(ids, content);

        for (const id of ids) {
            expect(result).toContain(
                `/settings/code-review/global/kody-rules/${id}?teamId=team-1)`,
            );
        }
        // Three distinct markdown links — count occurrences of "](https"
        const linkCount = (result.match(/\]\(https:/g) || []).length;
        expect(linkCount).toBe(3);
    });

    it('unwraps single backticks around the ID before linking', async () => {
        const ruleId = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
        kodyRulesService.findById.mockResolvedValue({
            uuid: ruleId,
            title: 'Backtick rule',
            repositoryId: 'global',
        });

        const content = `See \`${ruleId}\` for details.`;
        const result = await buildLinks([ruleId], content);

        // Backticks gone, replaced by the markdown link
        expect(result).toBe(
            `See [Backtick rule](https://app.kodus.io/settings/code-review/global/kody-rules/${ruleId}?teamId=team-1) for details.`,
        );
        expect(result).not.toContain(`\`${ruleId}\``);
    });

    it('unwraps triple backticks around the ID before linking', async () => {
        const ruleId = 'abcdef01-1234-5678-9abc-def012345678';
        kodyRulesService.findById.mockResolvedValue({
            uuid: ruleId,
            title: 'Triple backtick rule',
            repositoryId: 'global',
        });

        const content = `Block: \`\`\`${ruleId}\`\`\` end.`;
        const result = await buildLinks([ruleId], content);

        expect(result).toContain('[Triple backtick rule]');
        expect(result).not.toContain(`\`\`\`${ruleId}\`\`\``);
    });

    it('leaves content unchanged when the rule is not found in the database', async () => {
        const ruleId = '99999999-9999-9999-9999-999999999999';
        kodyRulesService.findById.mockResolvedValue(null);

        const content = `Unknown rule ${ruleId}.`;
        const result = await buildLinks([ruleId], content);

        expect(result).toBe(content);
    });

    it('continues processing other rules when one lookup throws', async () => {
        const idGood = '00000000-0000-0000-0000-000000000aaa';
        const idBad = '00000000-0000-0000-0000-000000000bad';
        kodyRulesService.findById.mockImplementation(async (id: string) => {
            if (id === idBad) throw new Error('db down');
            return { uuid: id, title: 'Good rule', repositoryId: 'global' };
        });

        const content = `Rules: ${idGood} and ${idBad}.`;
        const result = await buildLinks([idGood, idBad], content);

        expect(result).toContain('[Good rule]');
        expect(result).toContain(idBad); // bad ID stays as raw text
    });
});
