jest.mock(
    '@libs/code-review/infrastructure/agents/custom-agent-cli/custom-agent-cli.provisioner',
    () => ({ provisionCustomAgentClis: jest.fn() }),
);

import { provisionCustomAgentClis } from '@libs/code-review/infrastructure/agents/custom-agent-cli/custom-agent-cli.provisioner';

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
    return { stage, context, featureGate };
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

    it('carries the missing-sandbox warning on the local sandbox', async () => {
        // The provisioner installs nothing there (its own spec) and returns
        // one warning per CLI so the review says why the agent ran without it.
        const warning = { kind: 'CLI_INSTALL_FAILED', detail: 'needs E2B' };
        provision.mockResolvedValue({ byAgentId: {}, warnings: [warning] });
        const { stage, context, featureGate } = build({
            sandboxType: 'local',
        });
        const result: any = await (stage as any).executeStage(context);
        expect(featureGate.isEnabled).not.toHaveBeenCalled();
        expect(result.customAgentClis).toEqual({
            byAgentId: {},
            warnings: [warning],
        });
    });

    it('keeps the sandbox when provisioning throws', async () => {
        provision.mockRejectedValue(new Error('boom'));
        const { stage, context } = build({ sandboxType: 'e2b' });
        const result: any = await (stage as any).executeStage(context);
        expect(result.sandboxHandle).toBeDefined();
        expect(result.customAgentClis).toBeUndefined();
    });
});
