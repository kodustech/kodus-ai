/**
 * Guards the context → agent-input wiring that no typecheck would catch: the
 * fields are OPTIONAL, so a refactor that silently stops forwarding one (most
 * importantly `reviewDirective` from `@kody review <directive>`) would leave the
 * feature dead with every other test still green. Testing the pure mapping is
 * the cheap, durable seam for that.
 */
import {
    buildOrchestratorInput,
    type OrchestratorInputComputed,
} from './build-orchestrator-input';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

const computed: OrchestratorInputComputed = {
    changedFiles: [],
    prNumber: 1,
    repositoryId: 'repo-1',
    reviewOptions: {} as any,
    onAgentProgress: () => undefined,
    gitHubToken: undefined,
    callGraph: '',
    adaptiveProfile: { skipHeavyPasses: false } as any,
    linkedRepoAccess: undefined,
};

const makeContext = (
    over: Record<string, unknown> = {},
): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        pullRequest: { title: 'T', body: 'B' },
        repository: { fullName: 'kodus/test' },
        codeReviewConfig: {},
        ...over,
    }) as unknown as CodeReviewPipelineContext;

describe('buildOrchestratorInput — context→agent wiring', () => {
    it('forwards reviewDirective from context into the agent input', () => {
        const input = buildOrchestratorInput(
            makeContext({
                reviewDirective: 'the auth and session logic',
            }),
            computed,
        );
        expect(input.reviewDirective).toBe('the auth and session logic');
    });

    it('leaves reviewDirective undefined for a normal review (no directive)', () => {
        expect(
            buildOrchestratorInput(makeContext(), computed).reviewDirective,
        ).toBeUndefined();
    });

    it('appends traceContextPack into reviewDirective so the agent sees decisions', () => {
        const pack =
            '## Kodus Trace — decisions for changed files\n\n- use JWT';
        const input = buildOrchestratorInput(
            makeContext({
                reviewDirective: 'focus on auth',
                traceContextPack: pack,
            }),
            computed,
        );
        expect(input.reviewDirective).toContain('focus on auth');
        expect(input.reviewDirective).toContain('Kodus Trace');
        expect(input.reviewDirective).toContain('use JWT');
    });

    it('is inert when traceContextPack is empty — directive unchanged', () => {
        const input = buildOrchestratorInput(
            makeContext({
                reviewDirective: 'focus on auth',
                traceContextPack: '',
            }),
            computed,
        );
        expect(input.reviewDirective).toBe('focus on auth');
    });

    it('maps the load-bearing prompt fields from context', () => {
        const input = buildOrchestratorInput(
            makeContext({
                pullRequest: { title: 'My PR', body: 'desc' },
                codeReviewConfig: { reviewMode: 'deep' },
            }),
            computed,
        );
        expect(input.prTitle).toBe('My PR');
        expect(input.prBody).toBe('desc');
        expect(input.reviewMode).toBe('deep');
    });

    it('defaults reviewMode to normal when unset', () => {
        expect(
            buildOrchestratorInput(makeContext(), computed).reviewMode,
        ).toBe('normal');
    });

    it('passes the stage-computed locals through unchanged', () => {
        const input = buildOrchestratorInput(makeContext(), {
            ...computed,
            callGraph: '<CallGraph>x</CallGraph>',
            prNumber: 42,
        });
        expect(input.callGraph).toBe('<CallGraph>x</CallGraph>');
        expect(input.prNumber).toBe(42);
    });

    it('prefers stage-computed kodyRules (summary-swapped) over the raw config rules', () => {
        const configRules = [{ uuid: 'r1', rule: 'full long text' }];
        const swappedRules = [
            { uuid: 'r1', rule: 'WHAT TO VALIDATE:\n- condition' },
        ];
        const input = buildOrchestratorInput(
            makeContext({ codeReviewConfig: { kodyRules: configRules } }),
            { ...computed, kodyRules: swappedRules as any },
        );
        expect(input.kodyRules).toBe(swappedRules);
    });

    it('falls back to the config kodyRules when the stage computes none', () => {
        const configRules = [{ uuid: 'r1', rule: 'full long text' }];
        const input = buildOrchestratorInput(
            makeContext({ codeReviewConfig: { kodyRules: configRules } }),
            computed,
        );
        expect(input.kodyRules).toBe(configRules);
    });
});
