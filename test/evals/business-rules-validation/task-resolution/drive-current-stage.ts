import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import { IntentJudge } from '@libs/agents/business-validation/judge/intent-judge';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';
import { BusinessLogicValidationStage } from '@libs/code-review/pipeline/stages/business-logic-validation.stage';

import { frozenContext } from '../../../fixtures/frozen-pipeline-context';

import { FakeMcpHost, ToolCall } from './fake-mcp-host';
import { ResolutionFixture } from './fixture.types';

/** What a developer sees: what the judge read, what was posted, what was written to a tracker. */
export type ResolutionObservation = {
    outcome: ResolutionFixture['expect']['outcome'];
    /** What the judge was given as the task, when it ran at all. */
    taskReadByJudge?: string;
    /** Text posted on the PR, if anything. */
    comment?: string;
    /** Write calls made on any tracker. */
    writes: ToolCall[];
    /** Implementation details, printed when a case fails. */
    debug: Record<string, unknown>;
};

/** Fixture fields this driver cannot express. A case using one is not measured. */
export const CURRENT_STAGE_UNSUPPORTED: Array<keyof ResolutionFixture> = [
    'settings',
];

const ORG = { organizationId: 'org-eval', teamId: 'team-eval' };

/**
 * Runs BusinessLogicValidationStage with the real BusinessValidationService:
 * reference extraction, tracker catalog, MCP sessions and resolver. Only the
 * boundaries are replaced: the mcp-manager's connection list, the MCP servers
 * behind it (FakeMcpHost), and the judge, whose input is captured instead of
 * sent to a model.
 */
export async function driveCurrentStage(
    fixture: ResolutionFixture,
): Promise<ResolutionObservation> {
    const host = new FakeMcpHost(fixture);
    await host.start();

    try {
        const connections = buildConnections(fixture, host);
        const mcpManager = {
            getConnections: async (_org: unknown, format = true) =>
                format
                    ? connections.map((c) => c.config)
                    : connections.map((c) => c.item),
            getIntegrations: async () => [],
        };

        const service = new BusinessValidationService(
            mcpManager as never,
            { resolveTaskSlot: async () => undefined } as never,
            { findByKey: async () => null } as never,
            new SkillLoaderService(),
        );

        // The judge is the boundary: capture what it read instead of calling a model.
        let taskReadByJudge: string | undefined;
        const judge = jest
            .spyOn(IntentJudge.prototype, 'judge')
            .mockImplementation(async (input) => {
                taskReadByJudge = input.taskText;
                return {
                    needsMoreInfo: false,
                    status: 'compliant',
                    findings: [],
                    summary:
                        '## Business Rules Validation\n**Status:** Compliant',
                };
            });
        const translate = jest
            .spyOn(IntentJudge.prototype, 'translate')
            .mockImplementation(async (message) => message);

        const stage = new BusinessLogicValidationStage(service);
        const result = await stage.execute(
            frozenContext({
                organizationAndTeamData: ORG,
                platformType: 'GITHUB',
                pullRequest: {
                    number: fixture.pullRequest.number,
                    title: fixture.pullRequest.title,
                    body: fixture.pullRequest.body,
                    head: { ref: fixture.pullRequest.branch },
                    base: { ref: 'main' },
                },
                repository: {
                    id: fixture.repository.id,
                    name: fixture.repository.name,
                    fullName: `${fixture.repository.owner}/${fixture.repository.name}`,
                },
                codeReviewConfig: { reviewOptions: { business_logic: true } },
                pipelineMetadata: {},
                errors: [],
                changedFiles: fixture.pullRequest.files.map((file) => ({
                    filename: file.filename,
                    status: 'modified',
                    patch: file.patch,
                })),
            } as never),
        );
        judge.mockRestore();
        translate.mockRestore();

        const comment: string | undefined =
            result.businessLogicResults?.[0]?.suggestionContent;
        return {
            outcome:
                taskReadByJudge !== undefined
                    ? 'validated'
                    : comment
                      ? 'comment'
                      : 'silent',
            taskReadByJudge,
            comment,
            writes: host.calls.filter((c) => c.kind === 'write'),
            debug: {
                stageOutcome: result.businessLogicOutcome,
                calls: host.calls.map((c) => `${c.server}:${c.tool}:${c.kind}`),
            },
        };
    } finally {
        await host.stop();
    }
}

function buildConnections(fixture: ResolutionFixture, host: FakeMcpHost) {
    const entries = [
        {
            integrationId: 'kodus-mcp-default',
            appName: 'Kodus MCP',
            provider: 'kodusmcp',
            category: null as string | null,
            url: host.url('/kodus'),
            allowedTools: [
                'KODUS_GET_PULL_REQUEST',
                'KODUS_GET_PULL_REQUEST_DIFF',
            ],
        },
        ...(fixture.gitIssuesConnected
            ? [
                  {
                      integrationId: 'kodus-issues-default',
                      appName: 'Git Issues',
                      provider: 'kodusmcp',
                      category: 'task-management',
                      url: host.url('/issues'),
                      allowedTools: ['KODUS_GET_ISSUE', 'KODUS_LIST_ISSUES'],
                  },
              ]
            : []),
        ...fixture.trackers.map((t) => ({
            integrationId: t.integrationId,
            appName: t.appName,
            provider: t.provider,
            category: t.category,
            url: host.url(`/t/${t.integrationId}`),
            allowedTools: [
                ...t.tools.map((tool) => tool.name),
                ...(t.extraWriteTools ?? []),
            ],
        })),
    ];

    return entries.map((e, index) => ({
        config: {
            name: e.appName,
            provider: e.provider,
            type: 'http' as const,
            url: e.url,
            headers: {},
            retries: 1,
            timeout: 2_000,
            allowedTools: e.allowedTools,
            category: e.category,
            integrationId: e.integrationId,
        },
        item: {
            id: `conn-${index}`,
            organizationId: ORG.organizationId,
            integrationId: e.integrationId,
            provider: e.provider,
            status: 'ACTIVE',
            appName: e.appName,
            mcpUrl: e.url,
            allowedTools: e.allowedTools,
            category: e.category,
        },
    }));
}
