import { KodyRuleDetectorCompilerService } from './kody-rule-detector-compiler.service';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';

// The compiler now runs on the LOCAL (Vercel) stack via runStructuredReviewCall;
// mock it at that boundary (returns the canned compiler JSON).
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));
const mockRun = runStructuredReviewCall as jest.Mock;

const org = { organizationId: '11111111-1111-1111-1111-111111111111' } as any;

const make = (compilerOutput: any) => {
    mockRun.mockReset();
    mockRun.mockResolvedValue(compilerOutput);
    const permissionValidationService: any = {
        getBYOKConfig: jest.fn(async () => null), // system mode
    };
    const kodyRulesService: any = {
        updateRuleDetector: jest.fn(async () => ({})),
    };
    const svc = new KodyRuleDetectorCompilerService(
        permissionValidationService,
        {} as any, // observabilityService (unused — runStructuredReviewCall mocked)
        kodyRulesService,
    );
    return { svc, kodyRulesService };
};

const mechanicalRule = {
    uuid: 'r1',
    title: 'no console',
    rule: 'do not use console.log',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.info(x)' },
    ],
};

describe('KodyRuleDetectorCompilerService.compileAndSave (#1449 T0)', () => {
    it('persists a detector when the model compiles a passing regex', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        const [, ruleId, detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(ruleId).toBe('r1');
        expect(detector.pattern).toContain('console');
    });

    it('does NOT persist when the model declines (rule stays semantic)', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: false,
            reason: 'needs judgment',
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    it('does NOT persist when the compiled regex fails the gate', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'NEVER_MATCHES', // misses the incorrect example
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    it('clears a stale detector when an edited rule no longer compiles', async () => {
        const { svc, kodyRulesService } = make({ mechanical: false });
        await svc.compileAndSave(org, 'r1', {
            ...mechanicalRule,
            detector: { type: 'regex', pattern: 'old' }, // had one before
        });
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledWith(
            org.organizationId,
            'r1',
            null,
        );
    });

    it('never throws / never persists when the LLM call errors', async () => {
        const { svc, kodyRulesService } = make(null);
        mockRun.mockReset();
        mockRun.mockRejectedValue(new Error('llm down'));
        await expect(
            svc.compileAndSave(org, 'r1', mechanicalRule),
        ).resolves.toEqual({ compiled: false, declineReason: 'error' });
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });
});
