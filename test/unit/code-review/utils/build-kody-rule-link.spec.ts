import { buildKodyRuleLink } from '@libs/code-review/utils/build-kody-rule-link';

describe('buildKodyRuleLink', () => {
    const BASE = 'https://app.kodus.io';
    const RULE_ID = 'b207a89c-924b-4a0a-8070-2e860293b537';
    const REPO_ID = '769144833';
    const DIR_ID = 'cf5284b4-2510-464a-9eca-98efbf121d04';
    const TEAM_ID = '2d696ed8-901b-4f07-97ae-0743579d1df7';

    it('directory-scoped rule includes both directoryId and teamId (the David B bug fix)', () => {
        const link = buildKodyRuleLink(
            BASE,
            RULE_ID,
            { repositoryId: REPO_ID, directoryId: DIR_ID },
            { teamId: TEAM_ID },
        );
        expect(link).toBe(
            `${BASE}/settings/code-review/${REPO_ID}/kody-rules/${RULE_ID}` +
                `?directoryId=${DIR_ID}&teamId=${TEAM_ID}`,
        );
    });

    it('repo-level rule includes only teamId in the query string', () => {
        const link = buildKodyRuleLink(
            BASE,
            RULE_ID,
            { repositoryId: REPO_ID, directoryId: undefined },
            { teamId: TEAM_ID },
        );
        expect(link).toBe(
            `${BASE}/settings/code-review/${REPO_ID}/kody-rules/${RULE_ID}` +
                `?teamId=${TEAM_ID}`,
        );
    });

    it('global rule resolves the path segment to "global" and still appends teamId', () => {
        const link = buildKodyRuleLink(
            BASE,
            RULE_ID,
            { repositoryId: 'global', directoryId: undefined },
            { teamId: TEAM_ID },
        );
        expect(link).toBe(
            `${BASE}/settings/code-review/global/kody-rules/${RULE_ID}` +
                `?teamId=${TEAM_ID}`,
        );
    });

    it('omits the query string entirely when neither directoryId nor teamId is available', () => {
        const link = buildKodyRuleLink(BASE, RULE_ID, {
            repositoryId: REPO_ID,
            directoryId: undefined,
        });
        expect(link).toBe(
            `${BASE}/settings/code-review/${REPO_ID}/kody-rules/${RULE_ID}`,
        );
    });

    it('still appends directoryId when teamId is missing (defensive — rare in prod)', () => {
        const link = buildKodyRuleLink(BASE, RULE_ID, {
            repositoryId: REPO_ID,
            directoryId: DIR_ID,
        });
        expect(link).toBe(
            `${BASE}/settings/code-review/${REPO_ID}/kody-rules/${RULE_ID}` +
                `?directoryId=${DIR_ID}`,
        );
    });

    it('falls back to "global" path segment when rule.repositoryId is missing', () => {
        // Defensive — some callers come from a Partial<IKodyRule> map
        // where repositoryId may have been truncated by the LLM that
        // produced the suggestion. Better to land on the global rule
        // page than on a literal `/undefined/`.
        const link = buildKodyRuleLink(
            BASE,
            RULE_ID,
            { directoryId: undefined },
            { teamId: TEAM_ID },
        );
        expect(link).toBe(
            `${BASE}/settings/code-review/global/kody-rules/${RULE_ID}` +
                `?teamId=${TEAM_ID}`,
        );
    });

    it('encodes special characters in IDs', () => {
        const weirdTeam = 'team with spaces & symbols';
        const link = buildKodyRuleLink(
            BASE,
            RULE_ID,
            { repositoryId: REPO_ID, directoryId: DIR_ID },
            { teamId: weirdTeam },
        );
        // URLSearchParams encodes `&` and ` ` correctly so the link is safe to paste.
        expect(link).toContain(
            `teamId=team+with+spaces+%26+symbols`,
        );
    });
});
