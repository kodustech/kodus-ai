import { migrateRule } from './migrate-origin-request-type';

describe('migrateRule — .agents/rules origin mapping', () => {
    it('maps a legacy rule with a .agents/rules sourcePath to repo_file_sync', () => {
        const rule = { origin: 'user', sourcePath: '.agents/rules/architecture.md' };
        expect(migrateRule(rule)?.origin).toBe('repo_file_sync');
    });

    it('maps a nested .agents/rules sourcePath to repo_file_sync', () => {
        const rule = {
            origin: 'user',
            sourcePath: 'applications/sales/.agents/rules/style.md',
        };
        expect(migrateRule(rule)?.origin).toBe('repo_file_sync');
    });

    it('maps a case-variant .agents/rules sourcePath to repo_file_sync', () => {
        const rule = {
            origin: 'user',
            sourcePath: '.AGENTS/RULES/architecture.md',
        };
        expect(migrateRule(rule)?.origin).toBe('repo_file_sync');
    });

    it('leaves an already-migrated .agents/rules rule untouched', () => {
        const rule = {
            origin: 'repo_file_sync',
            sourcePath: '.agents/rules/architecture.md',
        };
        expect(migrateRule(rule)).toBeNull();
    });
});
