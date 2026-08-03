import {
    findOverrideForRepo,
    parsePrDescriptionOverrides,
} from '@libs/ee/linked-repositories';

describe('parsePrDescriptionOverrides', () => {
    it('returns empty map for empty input', () => {
        expect(parsePrDescriptionOverrides(undefined).size).toBe(0);
        expect(parsePrDescriptionOverrides('').size).toBe(0);
    });

    it('parses owner/repo#123 shorthand', () => {
        const map = parsePrDescriptionOverrides(
            'Please also check org/backend-api#456 for the contract change.',
        );
        expect(map.get('org/backend-api')).toEqual({
            kind: 'pr',
            repository: 'org/backend-api',
            prNumber: 456,
        });
    });

    it('parses GitHub PR URLs', () => {
        const map = parsePrDescriptionOverrides(
            'Companion: https://github.com/acme/payments/pull/99',
        );
        expect(map.get('acme/payments')).toEqual({
            kind: 'pr',
            repository: 'acme/payments',
            prNumber: 99,
        });
    });

    it('parses GitLab MR URLs with nested groups', () => {
        const map = parsePrDescriptionOverrides(
            'See https://gitlab.com/group/sub/project/-/merge_requests/12',
        );
        expect(map.get('group/sub/project')).toEqual({
            kind: 'pr',
            repository: 'group/sub/project',
            prNumber: 12,
        });
    });

    it('parses Bitbucket PR URLs', () => {
        const map = parsePrDescriptionOverrides(
            'https://bitbucket.org/ws/repo/pull-requests/7',
        );
        expect(map.get('ws/repo')?.kind).toBe('pr');
        expect((map.get('ws/repo') as any).prNumber).toBe(7);
    });

    it('parses owner/repo@branch', () => {
        const map = parsePrDescriptionOverrides(
            'Use org/backend-api@release/2.0 for the shape.',
        );
        expect(map.get('org/backend-api')).toEqual({
            kind: 'branch',
            repository: 'org/backend-api',
            branch: 'release/2.0',
        });
    });

    it('later mention of the same repo wins', () => {
        const map = parsePrDescriptionOverrides(
            'org/api#10 then later org/api@main',
        );
        expect(map.get('org/api')).toEqual({
            kind: 'branch',
            repository: 'org/api',
            branch: 'main',
        });
    });

    it('findOverrideForRepo matches fullName and unique short name', () => {
        const map = parsePrDescriptionOverrides('org/backend-api#5');
        expect(
            findOverrideForRepo(map, 'org/backend-api')?.kind,
        ).toBe('pr');
        expect(findOverrideForRepo(map, 'backend-api')?.kind).toBe('pr');
        expect(findOverrideForRepo(map, 'org/other')).toBeUndefined();
    });
});
