const run = jest.fn();
jest.mock('@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner', () => ({
    AiSdkAgentRunner: jest.fn(() => ({ run })),
}));
const buildTools = jest.fn();
jest.mock('@libs/code-review/infrastructure/agents/adapters/custom-agent-mcp.tools', () => ({
    ...jest.requireActual('@libs/code-review/infrastructure/agents/adapters/custom-agent-mcp.tools'),
    buildCustomAgentMcpTools: (...args: unknown[]) => buildTools(...args),
}));
const loadServers = jest.fn();
jest.mock('@libs/code-review/infrastructure/agents/adapters/custom-agent-tools', () => ({
    loadCustomAgentMcpServers: (...args: unknown[]) => loadServers(...args),
}));
jest.mock('./scan-model', () => ({
    ...jest.requireActual('./scan-model'),
    resolveScanModel: jest.fn(async () => ({
        model: { modelName: 'fireworks:deepseek', slot: { provider: 'openai_compatible', model: 'deepseek' } },
        rates: null,
    })),
}));

import {
    EXPORT_NO_PLUGIN_MESSAGE,
    ExportScanIssuesUseCase,
    readExportResults,
} from './export-scan-issues.use-case';

const ID_A = '65a000000000000000000001';
const ID_B = '65a000000000000000000002';
const ID_C = '65a000000000000000000003';

const issue = (uuid: string, over: Record<string, unknown> = {}) => ({
    uuid,
    organizationId: 'org-1',
    source: 'security_scan',
    title: `Finding ${uuid}`,
    description: 'Any user reads any order.',
    filePath: 'src/orders.ts',
    severity: 'high',
    repository: { id: 'repo-1', name: 'shop', full_name: 'acme/shop' },
    ...over,
});

function setup(issues: Record<string, any>) {
    const issuesService = {
        findById: jest.fn(async (id: string) => issues[id] ?? null),
        recordIssueExport: jest.fn(async () => undefined),
    };
    const useCase = new ExportScanIssuesUseCase(
        issuesService as any,
        {} as any,
        {} as any,
        { getConfig: jest.fn(async () => null) } as any,
        { getConnections: jest.fn() } as any,
    );
    loadServers.mockResolvedValue([{ name: 'Linear', integrationId: 'int-linear' }]);
    const close = jest.fn(async () => undefined);
    buildTools.mockResolvedValue({
        tools: [{ name: 'Linear__create_issue', description: '[Linear:create_issue] creates.', inputSchema: {}, execute: jest.fn() }],
        creates: ['Linear__create_issue'],
        call: jest.fn(),
        unavailable: [],
        close,
    });
    return { useCase, issuesService, close };
}

const exportOf = (useCase: ExportScanIssuesUseCase, ids: string[], readable: string[] | null = null) =>
    useCase.execute({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        issueIds: ids,
        integrationId: 'int-linear',
        destinationNote: 'Linear team SEC',
        readableRepositoryIds: readable,
        requestedBy: 'ana@acme.dev',
    });

describe('ExportScanIssuesUseCase', () => {
    beforeEach(() => jest.clearAllMocks());

    it('files each finding through the plugin and keeps where it went', async () => {
        const { useCase, issuesService, close } = setup({ [ID_A]: issue(ID_A) });
        run.mockResolvedValue({
            status: 'completed',
            steps: [],
            artifacts: [
                {
                    type: 'submitExport',
                    payload: { results: [{ issueId: ID_A, url: 'https://linear.app/acme/issue/SEC-1', ticketId: 'SEC-1', error: '' }] },
                },
            ],
        });

        const results = await exportOf(useCase, [ID_A]);

        expect(results).toEqual([
            { issueId: ID_A, status: 'created', url: 'https://linear.app/acme/issue/SEC-1', ticketId: 'SEC-1' },
        ]);
        expect(issuesService.recordIssueExport).toHaveBeenCalledWith('org-1', ID_A, {
            integrationId: 'int-linear',
            destination: 'Linear',
            url: 'https://linear.app/acme/issue/SEC-1',
            ticketId: 'SEC-1',
            exportedAt: expect.any(String),
            by: 'ana@acme.dev',
        });
        // Only read and create tools, and the run is told where.
        expect(buildTools.mock.calls[0][0].allow.name).toBe('isReadOrCreateMcpTool');
        const [, input] = run.mock.calls[0];
        expect(input.prompt).toContain('Linear team SEC');
        expect(input.prompt).toContain(`issueId ${ID_A}`);
        expect(close).toHaveBeenCalled();
    });

    it("never files another organization's finding, a review issue or a repository the caller cannot read", async () => {
        const { useCase } = setup({
            [ID_A]: issue(ID_A, { organizationId: 'org-2' }),
            [ID_B]: issue(ID_B, { source: 'code_review' }),
            [ID_C]: issue(ID_C, { repository: { id: 'repo-9', name: 'secret' } }),
        });

        const results = await exportOf(useCase, [ID_A, ID_B, ID_C, 'not-an-id'], ['repo-1']);

        expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
        expect(run).not.toHaveBeenCalled();
    });

    it('does not file again what this plugin already holds', async () => {
        const { useCase } = setup({
            [ID_A]: issue(ID_A, {
                exports: [{ integrationId: 'int-linear', destination: 'Linear', url: 'https://linear.app/x/SEC-9', exportedAt: 't' }],
            }),
        });

        const results = await exportOf(useCase, [ID_A]);

        expect(results).toEqual([{ issueId: ID_A, status: 'already', url: 'https://linear.app/x/SEC-9', ticketId: undefined }]);
        expect(run).not.toHaveBeenCalled();
    });

    it('says a finding failed when Kody reported nothing created for it', async () => {
        const { useCase, issuesService } = setup({ [ID_A]: issue(ID_A), [ID_B]: issue(ID_B) });
        run.mockResolvedValue({
            status: 'completed',
            steps: [],
            artifacts: [
                {
                    type: 'submitExport',
                    payload: { results: [{ issueId: ID_A, url: '', ticketId: '', error: 'the destination is public' }] },
                },
            ],
        });

        const results = await exportOf(useCase, [ID_A, ID_B]);

        expect(results).toEqual([
            { issueId: ID_A, status: 'failed', error: 'the destination is public' },
            { issueId: ID_B, status: 'failed', error: expect.stringContaining('did not report') },
        ]);
        expect(issuesService.recordIssueExport).not.toHaveBeenCalled();
    });

    it('refuses a plugin that offers nothing that creates', async () => {
        const { useCase } = setup({ [ID_A]: issue(ID_A) });
        buildTools.mockResolvedValue({ tools: [], creates: [], call: jest.fn(), unavailable: [], close: jest.fn(async () => undefined) });

        await expect(exportOf(useCase, [ID_A])).rejects.toThrow(EXPORT_NO_PLUGIN_MESSAGE);
    });
});

describe('readExportResults', () => {
    it('reads the results written as JSON in the final answer', () => {
        expect(
            readExportResults({
                status: 'completed',
                artifacts: [],
                steps: [{ message: { content: 'Done.\n{"results":[{"issueId":"a","url":"https://x/1","ticketId":"1","error":""}]}' } }],
            } as any),
        ).toEqual([{ issueId: 'a', url: 'https://x/1', ticketId: '1', error: undefined }]);
    });
});
