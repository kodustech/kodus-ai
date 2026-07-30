import { buildToolAliasKey } from './tool-aliases';

describe('buildToolAliasKey (characterization)', () => {
    it('normalizes casing and word boundaries into sorted tokens', () => {
        // camelCase split + lowercased + SORTED (order-independent matching)
        expect(buildToolAliasKey('getJiraIssue')).toBe('get issue jira');
    });

    it('singularizes and strips noise tokens (provider/workspace/plugin)', () => {
        // 'issues' -> 'issue', 'provider' dropped, sorted
        expect(buildToolAliasKey('provider_get_issues')).toBe('get issue');
    });

    it('matches two names that refer to the same tool', () => {
        expect(buildToolAliasKey('JIRA Get Issue')).toBe(
            buildToolAliasKey('jira-get-issues'),
        );
    });

    it('drops workspace/integration boilerplate', () => {
        expect(buildToolAliasKey('workspace integration search task')).toBe(
            'search task',
        );
    });
});
