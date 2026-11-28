import type { LlmGateway, LlmRequest } from './llm-gateway';
import { boundedFiles, cannotProveOf, RuntimeAgent, unmappedFilesOf } from './runtime-agent';

const httpProbe = (id: string, path: string) => ({
    id,
    purpose: 'the health check answers',
    expected: '200 with database ok',
    compare: ['status'],
    spec: { kind: 'http', target: { service: 'grafana', port: 3000 }, method: 'GET', path, timeoutMs: 30_000 },
});

function agentAnswering(second: unknown) {
    const seen: LlmRequest[] = [];
    const answers = ['{"explore":[]}', JSON.stringify(second)];
    const llm: LlmGateway = {
        complete: async (req) => {
            seen.push(JSON.parse(JSON.stringify(req)));
            return { text: answers.shift()!, usage: { inputTokens: 1, outputTokens: 1 } };
        },
    };
    const env = { exec: async () => ({ stepId: 's', exitCode: 0, stdout: '' }) } as any;
    return { agent: new RuntimeAgent(llm, env), seen };
}

const input = {
    runId: 'r',
    attempt: 1,
    organizationId: 'o',
    runToken: 't',
    entryPoints: [{ id: 'unmapped:pkg/api/health.go', kind: 'unmapped' as const, match: { file: 'pkg/api/health.go' } }],
    diffSummary: '--- pkg/api/health.go\n-\treturn healthy\n+\treturn false',
    files: [{ path: 'pkg/api/health.go', content: 'func (hs *HTTPServer) databaseHealthy() bool {}' }],
    baseClaimId: 'base',
    targets: [{ service: 'grafana', port: 3000, kind: 'http' }],
};

describe('RuntimeAgent plan for a changed file with no route of its own', () => {
    it('teaches scalar HTTP expectations and explicit JSON media types in the legacy fallback', async () => {
        const { agent, seen } = agentAnswering({ probes: [] });
        await agent.plan(input);
        expect(seen[0].messages[0].content).toContain('Content-Type');
        expect(seen[0].messages[0].content).toContain('"expected":"200"');
    });

    it('shows the model the unmapped file and its content', async () => {
        const { agent, seen } = agentAnswering({ probes: [] });
        await agent.plan(input);
        const user = JSON.parse(seen[0].messages[1].content as string);
        expect(user.entryPoints).toEqual([]);
        expect(user.unmappedFiles).toEqual(['pkg/api/health.go']);
        expect(user.files).toEqual([{ path: 'pkg/api/health.go', content: 'func (hs *HTTPServer) databaseHealthy() bool {}' }]);
    });

    it('keeps the route the agent says reaches the file, with the file as `via`', async () => {
        const { agent } = agentAnswering({ probes: [{ entryPoint: 'GET /api/health', via: 'pkg/api/health.go', probe: httpProbe('health', '/api/health') }] });
        const plan = await agent.plan(input);
        expect(plan.probes.map((p) => [p.entryPoint, p.via])).toEqual([['GET /api/health', 'pkg/api/health.go']]);
    });

    it('reads a route without a known file, or a file the diff does not leave unmapped, as unmapped', async () => {
        const { agent } = agentAnswering({
            probes: [
                { entryPoint: 'GET /api/health', probe: httpProbe('a', '/api/health') },
                { entryPoint: 'GET /api/health', via: 'pkg/other.go', probe: httpProbe('b', '/api/health') },
                { entryPoint: 'not a route', via: 'pkg/api/health.go', probe: httpProbe('c', '/api/health') },
            ],
        });
        const plan = await agent.plan(input);
        expect(plan.probes.map((p) => [p.entryPoint, p.via])).toEqual([
            ['unmapped', undefined],
            ['unmapped', undefined],
            ['unmapped', undefined],
        ]);
    });
});

describe('agent helpers', () => {
    it('unmappedFilesOf leaves out the truncation marker and repeats', () => {
        expect(
            unmappedFilesOf([
                { id: 'unmapped:a.go', kind: 'unmapped', match: { file: 'a.go' } },
                { id: 'unmapped:a.go', kind: 'unmapped', match: { file: 'a.go' } },
                { id: 'unmapped:diff-truncated', kind: 'unmapped', match: { file: 'b.go' } },
                { id: 'GET /x', kind: 'http_route', match: { file: 'c.go', method: 'GET', route: '/x' } },
            ] as any),
        ).toEqual(['a.go']);
    });

    it('boundedFiles keeps each head within the per-file and total bounds', () => {
        const big = 'x'.repeat(10_000);
        const out = boundedFiles(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}`, content: big })));
        expect(out[0].content.length).toBe(8_000);
        expect(out.reduce((n, f) => n + f.content.length, 0)).toBe(40_000);
        expect(out.length).toBe(5);
    });

    it('cannotProveOf reads strings and {entryPoint|file, reason} items', () => {
        expect(cannotProveOf(['GET /x: needs a login', { file: 'a.go', reason: 'CLI only' }, { entryPoint: 'GET /y' }, 3])).toEqual([
            'GET /x: needs a login',
            'a.go: CLI only',
        ]);
        expect(cannotProveOf(undefined)).toEqual([]);
    });
});
