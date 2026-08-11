/**
 * Unit coverage for linked-repositories settings form helpers (#1576).
 * Pure invariants: normalize + soft cap + case-insensitive dedupe.
 */

import {
    addLinkedRepository,
    MAX_LINKED_REPOSITORIES_UI,
    normalizeLinkedRepositories,
} from '../../../apps/web/src/features/ee/linked-repositories/linked-repositories-state';

describe('linked-repositories UI invariants', () => {
    it('exports the soft cap of 3', () => {
        expect(MAX_LINKED_REPOSITORIES_UI).toBe(3);
    });

    it('normalizes empty/malformed values to []', () => {
        expect(normalizeLinkedRepositories(undefined)).toEqual([]);
        expect(normalizeLinkedRepositories(null)).toEqual([]);
        expect(
            normalizeLinkedRepositories([{ repository: '' } as any]),
        ).toEqual([]);
        expect(
            normalizeLinkedRepositories([
                { repository: 'org/api' },
                { repository: '  ' },
            ]),
        ).toEqual([{ repository: 'org/api' }]);
    });

    it('adds a link until the soft cap, then no-ops', () => {
        let links = addLinkedRepository([], 'org/a');
        links = addLinkedRepository(links, 'org/b');
        links = addLinkedRepository(links, 'org/c');
        expect(links).toHaveLength(3);
        const atCap = addLinkedRepository(links, 'org/d');
        expect(atCap).toHaveLength(3);
        expect(atCap.map((l) => l.repository)).toEqual([
            'org/a',
            'org/b',
            'org/c',
        ]);
    });

    it('dedupes case-insensitively when adding', () => {
        let links = addLinkedRepository([], 'org/Backend-API');
        links = addLinkedRepository(links, 'org/backend-api');
        expect(links).toHaveLength(1);
        expect(links[0].repository).toBe('org/Backend-API');
    });
});
