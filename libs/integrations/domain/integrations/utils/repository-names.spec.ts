import { recordedNameMatches, repositoryNamesOf } from './repository-names';

describe('repository names', () => {
    it('reads the owner/name forms and the bare name of a listed repository', () => {
        expect(
            repositoryNamesOf({
                id: 7,
                name: 'API',
                full_name: 'Acme/API',
                organizationName: 'acme',
            }),
        ).toEqual({ full: ['acme/api'], bare: ['api'] });
        expect(repositoryNamesOf({ id: 8, name: 'group/sub/web' })).toEqual({
            full: ['group/sub/web'],
            bare: [],
        });
    });

    it('matches an owner/name record against full names and an Azure bare record against the bare name', () => {
        const azure = repositoryNamesOf({
            name: 'api',
            organizationName: 'proj',
        });

        expect(recordedNameMatches(azure, 'proj/api')).toBe(true);
        expect(recordedNameMatches(azure, 'API')).toBe(true);
        expect(recordedNameMatches(azure, 'other/api')).toBe(false);
        expect(recordedNameMatches(azure, 'web')).toBe(false);
    });

    it('answers undefined when the listing has no name of the recorded form', () => {
        expect(
            recordedNameMatches(repositoryNamesOf({ name: 'api' }), 'acme/api'),
        ).toBeUndefined();
        expect(
            recordedNameMatches(repositoryNamesOf({ name: 'acme/api' }), 'api'),
        ).toBeUndefined();
    });
});
