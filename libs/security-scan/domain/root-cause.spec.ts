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

    it("ties one feature's layers and files side by side, when the weakness is the same kind", () => {
        // Titles with no word in common: only the module link ties them.
        const repo = { ...base, title: 'Lookup skips organization scoping', cwe: 'CWE-639', filePath: 'libs/ai/repositories/contextReference.repository.ts' };
        const service = { ...base, title: 'Foreign rows overwritten through update', cwe: 'CWE-639', filePath: 'libs/ai/services/context/context-reference.service.ts' };
        const sibling = { ...base, title: 'DNS rebinding reaches internal hosts', cwe: 'CWE-918', filePath: 'libs/org/use-cases/test-byok-connection.use-case.ts' };
        const caller = { ...base, title: 'Org owner can SSRF via baseURL', cwe: 'CWE-918', filePath: 'libs/org/use-cases/get-models-by-provider.use-case.ts' };
        expect(rootCauseCandidates(service, [repo])).toEqual([repo]);
        expect(rootCauseCandidates(caller, [sibling])).toEqual([sibling]);
        // Another kind of weakness in the same module is not linked by it.
        const injection = { ...repo, title: 'Mongo operator injection', cwe: 'CWE-943' };
        expect(rootCauseCandidates(service, [injection])).toEqual([]);
        // A generic file name, or one that is only a layer, says nothing about the feature.
        const utilA = { ...base, title: 'a', cwe: 'CWE-918', filePath: 'apps/x/utils.ts' };
        const utilB = { ...base, title: 'b', cwe: 'CWE-918', filePath: 'apps/y/utils.ts' };
        expect(rootCauseCandidates(utilA, [utilB])).toEqual([]);
        const clientA = { ...base, title: 'a', cwe: 'CWE-918', filePath: 'apps/x/client.ts' };
        const clientB = { ...base, title: 'b', cwe: 'CWE-918', filePath: 'apps/y/client.ts' };
        expect(rootCauseCandidates(clientA, [clientB])).toEqual([]);
    });

    it('ties findings that start at the same route a few lines apart, or name the other file by its tail', () => {
        const info = {
            ...base,
            title: 'Login-info leaks poll state',
            cwe: 'CWE-639',
            filePath: 'libs/identity/use-cases/get-cli-login-info.use-case.ts',
            attackPath: [{ file: 'apps/api/cli-auth.controller.ts', line: 85, note: '' }],
        };
        const repo = {
            ...base,
            title: 'Session loaded by user code',
            cwe: 'CWE-200',
            filePath: 'libs/identity/repositories/cli-auth-session.repository.ts',
            attackPath: [{ file: 'apps/api/cli-auth.controller.ts', line: 92, note: '' }],
        };
        expect(rootCauseCandidates(repo, [info])).toEqual([info]);
        const route = {
            ...base,
            title: 'Route has no guard',
            cwe: 'CWE-862',
            filePath: 'routes.ts',
            attackPath: [{ file: 'routes.ts', line: 3, note: '' }, { file: 'cli-auth-session.repository.ts', line: 40, note: '' }],
        };
        expect(rootCauseCandidates(route, [repo])).toEqual([repo]);
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
