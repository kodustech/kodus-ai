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

function build(params: { sandboxType: 'e2b' | 'local'; flag: boolean }) {
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
    const featureGate: any = {
        isEnabled: jest.fn().mockResolvedValue(params.flag),
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

    it('installs the CLIs on E2B when the feature is on', async () => {
        const { stage, context } = build({ sandboxType: 'e2b', flag: true });
        const result: any = await (stage as any).executeStage(context);
        expect(provision).toHaveBeenCalledWith(
            expect.objectContaining({ changedFiles: ['src/app.ts'] }),
        );
        expect(result.customAgentClis.byAgentId['agent-1']).toHaveLength(1);
    });

    it('never installs on the local sandbox', async () => {
        const { stage, context, featureGate } = build({
            sandboxType: 'local',
            flag: true,
        });
        const result: any = await (stage as any).executeStage(context);
        expect(provision).not.toHaveBeenCalled();
        expect(featureGate.isEnabled).not.toHaveBeenCalled();
        expect(result.customAgentClis).toBeUndefined();
    });

    it('does not install when the feature is off for the org', async () => {
        const { stage, context } = build({ sandboxType: 'e2b', flag: false });
        const result: any = await (stage as any).executeStage(context);
        expect(provision).not.toHaveBeenCalled();
        expect(result.customAgentClis).toBeUndefined();
    });

    it('keeps the sandbox when provisioning throws', async () => {
        provision.mockRejectedValue(new Error('boom'));
        const { stage, context } = build({ sandboxType: 'e2b', flag: true });
        const result: any = await (stage as any).executeStage(context);
        expect(result.sandboxHandle).toBeDefined();
        expect(result.customAgentClis).toBeUndefined();
    });
});
