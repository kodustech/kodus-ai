import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import { applyBusinessRulesVerdict } from './business-rules-verifier';
import { IntentJudge } from './intent-judge';
import type { ValidationResult } from './validation.types';
import { parseBusinessRulesValidationResult } from './validation-result.parser';
import {
    readValidationArtifact,
    resolveValidationStatus,
    VALIDATION_RESULT_TOOL,
} from './validation-verdict';

/** #2019 — the analyzer's verdict travels as data from the result tool to the
 *  caller; nothing downstream reads it back out of the markdown report. */

const completed = (overrides: Partial<ValidationResult>): ValidationResult => ({
    needsMoreInfo: false,
    reason: 'analysis_ready',
    summary: '## Business Rules Validation',
    ...overrides,
});

function makeJudge(): IntentJudge {
    return new IntentJudge(
        undefined,
        { analyzerTimeoutMs: 5_000, analyzerMaxIterations: 1 },
        {},
    );
}

const judgeInput = {
    instructions: 'SYS',
    task: { tracker: 'Linear', id: 'PLAT-41', title: 'Scale servings' },
    taskText: 'Task ID: PLAT-41',
    taskQuality: 'COMPLETE' as const,
    diff: '+ code',
    userLanguage: 'en-US',
};

const runResult = (content: string, artifacts: unknown[] = []) =>
    ({
        steps: [{ message: { content } }],
        artifacts,
        usage: {},
    }) as any;

afterEach(() => jest.restoreAllMocks());

describe('resolveValidationStatus', () => {
    it('returns the status the analyzer gave', () => {
        expect(
            resolveValidationStatus(completed({ status: 'scope_mismatch' })),
        ).toBe('scope_mismatch');
    });

    it('derives issues_found from a blocking or partial finding when status is missing', () => {
        expect(
            resolveValidationStatus(
                completed({ findings: [{ severity: 'must_fix', title: 'x' }] }),
            ),
        ).toBe('issues_found');
        expect(
            resolveValidationStatus(
                completed({
                    findings: [{ severity: 'suggestion', title: 'x' }],
                }),
            ),
        ).toBe('issues_found');
    });

    it('derives compliant from informational-only or empty findings', () => {
        expect(
            resolveValidationStatus(
                completed({ findings: [{ severity: 'info', title: 'x' }] }),
            ),
        ).toBe('compliant');
        expect(resolveValidationStatus(completed({ findings: [] }))).toBe(
            'compliant',
        );
    });

    it('has no verdict for a result that did not complete or carries neither field', () => {
        expect(
            resolveValidationStatus(
                completed({ needsMoreInfo: true, status: 'compliant' }),
            ),
        ).toBeUndefined();
        expect(resolveValidationStatus(completed({}))).toBeUndefined();
        expect(resolveValidationStatus(undefined)).toBeUndefined();
    });
});

describe('parseBusinessRulesValidationResult — verdict fields', () => {
    it('reads status and findings from the result object', () => {
        const parsed = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            status: 'issues_found',
            findings: [
                {
                    severity: 'must_fix',
                    title: 'Badge shows for unassigned tickets',
                },
                { severity: 'info', title: 'Null guard present' },
            ],
            summary: 'report',
        });

        expect(parsed.status).toBe('issues_found');
        expect(parsed.findings).toEqual([
            {
                severity: 'must_fix',
                title: 'Badge shows for unassigned tickets',
            },
            { severity: 'info', title: 'Null guard present' },
        ]);
    });

    it('reads them from a JSON answer written as text', () => {
        const parsed = parseBusinessRulesValidationResult(
            '```json\n{"needsMoreInfo": false, "status": "compliant", "findings": [], "summary": "ok"}\n```',
        );

        expect(parsed.status).toBe('compliant');
        expect(parsed.findings).toEqual([]);
    });

    it('drops an unknown status and findings with an unknown severity', () => {
        const parsed = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            status: 'Compliant',
            findings: [
                { severity: 'blocker', title: 'x' },
                { severity: 'info', title: 'y' },
            ],
            summary: 'report',
        });

        expect(parsed.status).toBeUndefined();
        expect(parsed.findings).toEqual([{ severity: 'info', title: 'y' }]);
    });
});

describe('applyBusinessRulesVerdict — refuted claim', () => {
    it('leaves a compliant verdict with no findings, not just a rewritten summary', () => {
        const out = applyBusinessRulesVerdict(
            completed({
                status: 'issues_found',
                findings: [{ severity: 'must_fix', title: 'x' }],
            }),
            { keep: false, rationale: 'O diff implementa o critério.' },
        );

        expect(out.status).toBe('compliant');
        expect(out.findings).toEqual([]);
        expect(resolveValidationStatus(out)).toBe('compliant');
    });
});

describe('analyzer run — submitValidation result tool', () => {
    const verdict = {
        needsMoreInfo: false,
        status: 'compliant',
        findings: [],
        summary: '## Business Rules Validation\n**Status:** Em conformidade',
    };

    it('offers the result tool to the analyzer and returns its payload', async () => {
        const runSpy = jest
            .spyOn(AiSdkAgentRunner.prototype, 'run')
            .mockResolvedValue(
                runResult('', [
                    { type: VALIDATION_RESULT_TOOL, payload: verdict },
                ]),
            );

        const result = await makeJudge().judge(judgeInput);

        const spec = runSpy.mock.calls[0][0];
        expect(spec.resultToolName).toBe(VALIDATION_RESULT_TOOL);
        expect(spec.tools.list().map((t: { name: string }) => t.name)).toEqual([
            VALIDATION_RESULT_TOOL,
        ]);
        expect(result.status).toBe('compliant');
    });

    it('keeps the formatter a plain completion with no tools', async () => {
        const runSpy = jest
            .spyOn(AiSdkAgentRunner.prototype, 'run')
            .mockResolvedValue(runResult('texto'));

        const text = await makeJudge().translate('message', 'pt-BR');

        const spec = runSpy.mock.calls[0][0];
        expect(spec.resultToolName).toBeUndefined();
        expect(spec.tools.list()).toEqual([]);
        expect(text).toBe('texto');
    });

    it('reads the verdict from the result tool before the text answer', async () => {
        jest.spyOn(AiSdkAgentRunner.prototype, 'run').mockResolvedValue(
            runResult('**Status:** Issues Found — no structured payload here', [
                { type: VALIDATION_RESULT_TOOL, payload: verdict },
            ]),
        );

        const result = await makeJudge().judge(judgeInput);

        expect(result.status).toBe('compliant');
        expect(result.summary).toBe(verdict.summary);
    });

    it('falls back to the text answer when the analyzer did not call the tool', async () => {
        jest.spyOn(AiSdkAgentRunner.prototype, 'run').mockResolvedValue(
            runResult(JSON.stringify({ ...verdict, status: 'issues_found' })),
        );

        const result = await makeJudge().judge(judgeInput);

        expect(result.status).toBe('issues_found');
    });

    it('takes the last submission when the analyzer called the tool more than once', () => {
        expect(
            readValidationArtifact({
                steps: [],
                artifacts: [
                    {
                        type: VALIDATION_RESULT_TOOL,
                        payload: { status: 'issues_found' },
                    },
                    { type: 'other', payload: {} },
                    {
                        type: VALIDATION_RESULT_TOOL,
                        payload: { status: 'compliant' },
                    },
                ],
                usage: {},
            } as any),
        ).toEqual({ status: 'compliant' });
    });
});
