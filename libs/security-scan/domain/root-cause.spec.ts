import { rootCauseCandidates, titleSimilarity } from './root-cause';

const base = {
    vulnerabilityClass: 'authz' as const,
    description: 'd',
    severity: 'high' as const,
    startLine: 10,
    endLine: 12,
};

describe('rootCauseCandidates', () => {
    it('ties a missing check and the denial of service it allows in the same function, whatever the CWE', () => {
        const auth = { ...base, title: 'No auth on login-init', cwe: 'CWE-862', filePath: 'a.ts', symbol: 'init' };
        const dos = { ...base, vulnerabilityClass: 'resource_exhaustion' as const, title: 'Unbounded rows', cwe: 'CWE-400', filePath: 'a.ts', symbol: 'init', startLine: 30, endLine: 31 };
        expect(rootCauseCandidates(dos, [auth])).toEqual([auth]);
    });

    it('ties the route to the query it reaches through the attack path', () => {
        const query = { ...base, title: 'Order loaded by id', cwe: 'CWE-639', filePath: 'repo.ts' };
        const route = {
            ...base,
            title: 'Route has no guard',
            cwe: 'CWE-862',
            filePath: 'routes.ts',
            attackPath: [{ file: 'routes.ts', line: 3, note: '' }, { file: 'repo.ts', line: 40, note: '' }],
        };
        expect(rootCauseCandidates(route, [query])).toEqual([query]);
    });

    it('ties the same unsafe setting repeated in other files', () => {
        const a = { ...base, title: 'Postgres TLS verification disabled', cwe: 'CWE-295', filePath: 'db/a.ts' };
        const b = { ...base, title: 'Postgres TLS certificate verification disabled', cwe: 'CWE-295', filePath: 'db/b.ts' };
        expect(rootCauseCandidates(b, [a])).toEqual([a]);
    });

    it('leaves unrelated findings out', () => {
        const a = { ...base, title: 'SQL injection in search', cwe: 'CWE-89', filePath: 'search.ts', symbol: 'search' };
        const b = { ...base, title: 'Open redirect after login', cwe: 'CWE-601', filePath: 'login.ts', symbol: 'login' };
        expect(rootCauseCandidates(b, [a])).toEqual([]);
    });

    it('puts the same function before a weaker link and caps the list', () => {
        const fn = { ...base, title: 'x', cwe: 'CWE-862', filePath: 'a.ts', symbol: 'f' };
        const titled = Array.from({ length: 10 }, (_, i) => ({
            ...base,
            title: 'Postgres TLS verification disabled',
            cwe: 'CWE-295',
            filePath: `db/${i}.ts`,
        }));
        const subject = { ...base, title: 'Postgres TLS verification disabled', cwe: 'CWE-295', filePath: 'a.ts', symbol: 'f' };
        const got = rootCauseCandidates(subject, [...titled, fn], 3);
        expect(got).toHaveLength(3);
        expect(got[0]).toBe(fn);
    });
});

describe('titleSimilarity', () => {
    it('reads shared words over all words', () => {
        expect(titleSimilarity('TLS verification disabled', 'TLS verification disabled')).toBe(1);
        expect(titleSimilarity('SQL injection', 'Open redirect')).toBe(0);
    });
});
