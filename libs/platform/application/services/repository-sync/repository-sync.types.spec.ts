import { encrypt } from '@libs/common/utils/crypto';

import {
    credentialFingerprint,
    filterDiscoveredRepositories,
} from './repository-sync.types';

const repo = (id: string, flags: Record<string, boolean> = {}) =>
    ({ id, name: id, ...flags }) as any;

describe('filterDiscoveredRepositories', () => {
    const listing = [
        repo('plain'),
        repo('archived', { archived: true }),
        repo('fork', { fork: true }),
        repo('mirror', { mirror: true }),
        repo('archived-fork', { archived: true, fork: true }),
    ];

    it('skips archived repositories always, and forks and mirrors by default', () => {
        const result = filterDiscoveredRepositories(listing, {});

        expect(result.eligible.map((r) => r.id)).toEqual(['plain']);
        expect(result.skipped).toEqual({ archived: 2, forksAndMirrors: 2 });
    });

    it('keeps forks and mirrors when asked, still skipping archived ones', () => {
        const result = filterDiscoveredRepositories(listing, {
            includeForksAndMirrors: true,
        });

        expect(result.eligible.map((r) => r.id)).toEqual([
            'plain',
            'fork',
            'mirror',
        ]);
        expect(result.skipped).toEqual({ archived: 2, forksAndMirrors: 0 });
    });
});

describe('credentialFingerprint', () => {
    it('is the same for one token saved twice (different ciphertexts)', () => {
        const a = credentialFingerprint('gitlab', {
            host: 'gitlab.example',
            accessToken: encrypt('glpat-same'),
        });
        const b = credentialFingerprint('gitlab', {
            host: 'gitlab.example',
            accessToken: encrypt('glpat-same'),
        });

        expect(a).toBeTruthy();
        expect(a).toEqual(b);
    });

    it('differs for another token, host or platform', () => {
        const base = credentialFingerprint('gitlab', {
            host: 'gitlab.example',
            accessToken: encrypt('glpat-1'),
        });

        expect(
            credentialFingerprint('gitlab', {
                host: 'gitlab.example',
                accessToken: encrypt('glpat-2'),
            }),
        ).not.toEqual(base);
        expect(
            credentialFingerprint('gitlab', {
                host: 'other.example',
                accessToken: encrypt('glpat-1'),
            }),
        ).not.toEqual(base);
        expect(
            credentialFingerprint('forgejo', {
                host: 'gitlab.example',
                accessToken: encrypt('glpat-1'),
            }),
        ).not.toEqual(base);
    });

    it('identifies a GitHub App by its installation', () => {
        expect(
            credentialFingerprint('github', {
                installationId: 42,
                authToken: encrypt('short-lived-1'),
            }),
        ).toEqual(
            credentialFingerprint('github', {
                installationId: 42,
                authToken: encrypt('short-lived-2'),
            }),
        );
    });

    it('is null without a credential to identify', () => {
        expect(credentialFingerprint('gitlab', null)).toBeNull();
        expect(credentialFingerprint('gitlab', { host: 'x' })).toBeNull();
    });
});
