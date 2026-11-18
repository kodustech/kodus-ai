jest.mock(
    '@libs/code-review/infrastructure/agents/custom-agent-cli/custom-agent-cli.provisioner',
    () => ({ provisionCustomAgentClis: jest.fn() }),
);

import { provisionCustomAgentClis } from '@libs/code-review/infrastructure/agents/custom-agent-cli/custom-agent-cli.provisioner';

import { ULTRA_RUN_LEASE_TTL_MS } from '@libs/ee/ultra-review/ultra-review.executor';

import { CreateSandboxStage } from './create-sandbox.stage';

const provision = provisionCustomAgentClis as jest.Mock;

const agent = {
    id: 'agent-1',
    name: 'Lint',
    enabled: true,
    tools: {
        cli: [
            {
                name: 'lintkit',
                install: 'npm install -g lintkit@2.4.1',
                binary: 'lintkit',
                allowedPrefixes: ['check'],
                usage: '',
                runsProjectCode: false,
                allowedDomains: ['api.lintkit.example'],
            },
        ],
    },
};

function build(params: { sandboxType: 'e2b' | 'local' }) {
    const sandbox: any = { type: params.sandboxType, baseBranch: 'main' };
    const leaseManager: any = {
        acquire: jest.fn().mockResolvedValue({ sandbox, leaseId: 'lease-1' }),
        release: jest.fn(),
    };
    const cloneParamsResolver: any = {
        resolve: jest.fn().mockResolvedValue({
            url: 'https://git.example/acme/app.git',
            branch: 'feature',
            platform: 'github',
        }),
    };
    // Custom agents are on for every organization: no feature flag gates
    // the install, so every flag reads off here.
    const featureGate: any = {
        isEnabled: jest.fn().mockResolvedValue(false),
    };
    const organizationService: any = {
        getReleaseTrack: jest.fn().mockResolvedValue('beta'),
    };
    const stage = new CreateSandboxStage(
        leaseManager,
        cloneParamsResolver,
        featureGate,
        organizationService,
    );
    const context: any = {
        origin: 'github',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1' },
        pullRequest: { number: 7 },
        changedFiles: [{ filename: 'src/app.ts' }],
        codeReviewConfig: { customAgents: [agent] },
    };
    return { stage, context, featureGate, leaseManager };
}

describe('CreateSandboxStage custom agent CLIs', () => {
    beforeEach(() => {
        provision.mockReset();
        provision.mockResolvedValue({
            byAgentId: { 'agent-1': [{ agentId: 'agent-1' }] },
            warnings: [],
        });
    });

    it('installs the CLIs on E2B with no feature flag on', async () => {
        const { stage, context } = build({ sandboxType: 'e2b' });
        const result: any = await (stage as any).executeStage(context);
        expect(provision).toHaveBeenCalledWith(
            expect.objectContaining({ changedFiles: ['src/app.ts'] }),
        );
        expect(result.customAgentClis.byAgentId['agent-1']).toHaveLength(1);
    });

    it('installs for a disabled agent asked for by `@kody -v`', async () => {
        const { stage, context } = build({ sandboxType: 'e2b' });
        context.codeReviewConfig.customAgents = [{ ...agent, enabled: false }];
        context.onlyCustomAgent = 'lint';
        await (stage as any).executeStage(context);
        expect(provision).toHaveBeenCalledWith(
            expect.objectContaining({ onlyCustomAgent: 'lint' }),
        );
    });

    it('asks for no install on a Kodus CLI review, with the reason', async () => {
        const { stage, context } = build({ sandboxType: 'e2b' });
        context.origin = 'cli';
        context.gitContext = {
            remote: 'https://git.example/acme/app.git',
            branch: 'feature',
        };
        await (stage as any).executeStage(context);
        expect(provision).toHaveBeenCalledWith(
            expect.objectContaining({
                skipReason: expect.stringContaining('Kodus CLI reviews'),
            }),
        );
    });

    it('keeps the sandbox when provisioning throws', async () => {
        provision.mockRejectedValue(new Error('boom'));
        const { stage, context } = build({ sandboxType: 'e2b' });
        const result: any = await (stage as any).executeStage(context);
        expect(result.sandboxHandle).toBeDefined();
        expect(result.customAgentClis).toBeUndefined();
    });
});

describe('CreateSandboxStage on a PR whose changed files are all ignored', () => {
    const ignoredFileChanges = [
        { filename: 'package.json', status: 'modified' },
    ];

    beforeEach(() => {
        provision.mockReset();
        provision.mockResolvedValue({ byAgentId: {}, warnings: [] });
    });

    it('creates the sandbox when a custom agent names one of the files (#2172)', async () => {
        const { stage, context } = build({ sandboxType: 'e2b' });
        context.changedFiles = [];
        context.ignoredFileChanges = ignoredFileChanges;
        context.codeReviewConfig.customAgents = [
            { ...agent, scope: { include: ['package.json'] } },
        ];

        const result: any = await (stage as any).executeStage(context);

        expect(result.sandboxHandle).toBeDefined();
        expect(provision).toHaveBeenCalledWith(
            expect.objectContaining({
                changedFiles: [],
                ignoredFiles: ['package.json'],
            }),
        );
    });

    it('creates none when no custom agent names one of them', async () => {
        const { stage, context } = build({ sandboxType: 'e2b' });
        context.changedFiles = [];
        context.ignoredFileChanges = ignoredFileChanges;

        const result: any = await (stage as any).executeStage(context);

        expect(result.sandboxHandle).toBeUndefined();
        expect(provision).not.toHaveBeenCalled();
    });
});

describe('CreateSandboxStage lease on an Ultra review', () => {
    beforeEach(() => {
        provision.mockReset();
        provision.mockResolvedValue(undefined);
    });

    it("keeps the PR's sandbox as long as the Ultra models run; another review keeps the default", async () => {
        const ultra = build({ sandboxType: 'e2b' });
        ultra.context.ultra = { models: [] };
        await (ultra.stage as any).executeStage(ultra.context);
        expect(ultra.leaseManager.acquire.mock.calls[0][2]).toBe(
            ULTRA_RUN_LEASE_TTL_MS,
        );

        const balanced = build({ sandboxType: 'e2b' });
        await (balanced.stage as any).executeStage(balanced.context);
        expect(balanced.leaseManager.acquire.mock.calls[0][2]).toBeUndefined();
    });

    it('a run sandbox gets its own key and the lease asked for; zero is no lease asked', async () => {
        const { stage, context, leaseManager } = build({ sandboxType: 'e2b' });
        await stage.acquireRunSandbox(context, 'ultra-2', 1234);
        expect(leaseManager.acquire.mock.calls[0][0]).toBe(
            'org-1:repo-1:7#ultra-2',
        );
        expect(leaseManager.acquire.mock.calls[0][2]).toBe(1234);
        await stage.acquireRunSandbox(context, 'ultra-3', 0);
        expect(leaseManager.acquire.mock.calls[1][2]).toBeUndefined();
    });
});
