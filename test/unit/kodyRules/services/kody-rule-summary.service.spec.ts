import { createHash } from 'crypto';
import { KodyRuleSummaryService } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const loggerSpy = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => loggerSpy,
}));

const tracedGenerateTextMock = jest.fn();
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: (...args: unknown[]) => tracedGenerateTextMock(...args),
}));

jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(() => ({})),
    getModelName: jest.fn(() => 'openai_compatible:test-model'),
}));

const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');

const LONG_TEXT = 'x'.repeat(1001);
const orgData = { organizationId: 'org-1', teamId: 'team-1' };

function createService(
    opts: {
        byokConfig?: object | null;
        subscriptionStatus?: SubscriptionStatus | string;
        repository?: Partial<{
            findByOrganizationId: jest.Mock;
            updateRule: jest.Mock;
        }>;
    } = {},
) {
    const permissionValidationService = {
        getBYOKConfig: jest
            .fn()
            .mockResolvedValue(
                opts.byokConfig === undefined
                    ? { main: { model: 'm' } }
                    : opts.byokConfig,
            ),
        getSubscriptionStatus: jest
            .fn()
            .mockResolvedValue(
                opts.subscriptionStatus ?? SubscriptionStatus.TRIAL,
            ),
    };
    const repository = {
        findByOrganizationId: jest
            .fn()
            .mockResolvedValue({ uuid: 'doc-uuid' }),
        updateRule: jest.fn().mockResolvedValue({ uuid: 'doc-uuid' }),
        ...opts.repository,
    };
    const service = new KodyRuleSummaryService(
        permissionValidationService as any,
        repository as any,
    );
    return { service, permissionValidationService, repository };
}

const validSummaryText =
    'WHAT TO VALIDATE:\n- condition\n\nHOW TO VALIDATE:\n- signal';

describe('KodyRuleSummaryService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tracedGenerateTextMock.mockResolvedValue({ text: validSummaryText });
    });

    describe('isLong', () => {
        it('treats exactly 1000 chars as short and 1001 as long', () => {
            const { service } = createService();

            expect(service.isLong('x'.repeat(1000))).toBe(false);
            expect(service.isLong('x'.repeat(1001))).toBe(true);
            expect(service.isLong(undefined)).toBe(false);
        });
    });

    describe('resolveForReview', () => {
        it('swaps a long rule for its summary when the sourceHash matches', () => {
            const { service } = createService();
            const rule: Partial<IKodyRule> = {
                uuid: 'r1',
                rule: LONG_TEXT,
                summary: {
                    content: validSummaryText,
                    sourceHash: sha256(LONG_TEXT),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };

            const resolved = service.resolveForReview(rule);

            expect(resolved.rule).toBe(validSummaryText);
            // original never mutated — other consumers see the full text
            expect(rule.rule).toBe(LONG_TEXT);
        });

        it('returns the original and logs when the sourceHash does not match', () => {
            const { service } = createService();
            const rule: Partial<IKodyRule> = {
                uuid: 'r1',
                rule: LONG_TEXT,
                summary: {
                    content: validSummaryText,
                    sourceHash: sha256('some other text'),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };

            const resolved = service.resolveForReview(rule);

            expect(resolved.rule).toBe(LONG_TEXT);
            expect(loggerSpy.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('stale summary'),
                }),
            );
        });

        it('leaves short rules untouched even when a summary exists', () => {
            const { service } = createService();
            const shortText = 'short rule';
            const rule: Partial<IKodyRule> = {
                uuid: 'r1',
                rule: shortText,
                summary: {
                    content: 'stale content from a former long version',
                    sourceHash: sha256(shortText),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };

            const resolved = service.resolveForReview(rule);

            expect(resolved.rule).toBe(shortText);
        });
    });

    describe('generate', () => {
        it('returns a summary with the sourceHash of the exact rule text', async () => {
            const { service } = createService();

            const summary = await service.generate(
                { uuid: 'r1', title: 't', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).not.toBeNull();
            expect(summary!.content).toBe(validSummaryText);
            expect(summary!.sourceHash).toBe(sha256(LONG_TEXT));
            expect(summary!.model).toBe('openai_compatible:test-model');
        });

        it('returns null for short rules without calling the LLM', async () => {
            const { service } = createService();

            const summary = await service.generate(
                { uuid: 'r1', rule: 'short' },
                orgData,
            );

            expect(summary).toBeNull();
            expect(tracedGenerateTextMock).not.toHaveBeenCalled();
        });

        it('skips generation post-trial without BYOK', async () => {
            const { service } = createService({
                byokConfig: null,
                subscriptionStatus: SubscriptionStatus.EXPIRED,
            });

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).toBeNull();
            expect(tracedGenerateTextMock).not.toHaveBeenCalled();
        });

        it('generates on the managed default during trial without BYOK', async () => {
            const { service } = createService({
                byokConfig: null,
                subscriptionStatus: SubscriptionStatus.TRIAL,
            });

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).not.toBeNull();
            expect(tracedGenerateTextMock).toHaveBeenCalled();
        });

        it('discards output missing the required sections', async () => {
            const { service } = createService();
            tracedGenerateTextMock.mockResolvedValue({
                text: 'some prose that is not the expected spec',
            });

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).toBeNull();
        });

        it('returns null instead of throwing when the LLM call fails', async () => {
            const { service } = createService();
            tracedGenerateTextMock.mockRejectedValue(new Error('boom'));

            const summary = await service.generate(
                { uuid: 'r1', rule: LONG_TEXT },
                orgData,
            );

            expect(summary).toBeNull();
        });

        it('does not set a temperature (some BYOK models reject 0)', async () => {
            const { service } = createService();

            await service.generate({ uuid: 'r1', rule: LONG_TEXT }, orgData);

            const callArgs = tracedGenerateTextMock.mock.calls[0][0];
            expect(callArgs).not.toHaveProperty('temperature');
        });
    });

    describe('ensureSummaries', () => {
        it('generates and persists only for long rules lacking a valid summary', async () => {
            const { service, repository } = createService();
            const alreadySummarized: Partial<IKodyRule> = {
                uuid: 'ok',
                rule: LONG_TEXT,
                summary: {
                    content: validSummaryText,
                    sourceHash: sha256(LONG_TEXT),
                    generatedAt: new Date(),
                    model: 'm',
                },
            };
            const shortRule: Partial<IKodyRule> = { uuid: 's', rule: 'short' };
            const pendingRule: Partial<IKodyRule> = {
                uuid: 'p',
                rule: LONG_TEXT,
            };

            const result = await service.ensureSummaries(
                [alreadySummarized, shortRule, pendingRule],
                orgData,
            );

            expect(tracedGenerateTextMock).toHaveBeenCalledTimes(1);
            expect(repository.updateRule).toHaveBeenCalledWith(
                'doc-uuid',
                'p',
                expect.objectContaining({
                    summary: expect.objectContaining({
                        sourceHash: sha256(LONG_TEXT),
                    }),
                }),
            );
            const updated = result.find((r) => r.uuid === 'p');
            expect(updated?.summary?.content).toBe(validSummaryText);
        });

        it('still returns the in-memory summary when persistence fails', async () => {
            const { service } = createService({
                repository: {
                    updateRule: jest
                        .fn()
                        .mockRejectedValue(new Error('mongo down')),
                },
            });

            const result = await service.ensureSummaries(
                [{ uuid: 'p', rule: LONG_TEXT }],
                orgData,
            );

            expect(result[0].summary?.content).toBe(validSummaryText);
        });

        it('returns rules untouched when generation fails', async () => {
            const { service, repository } = createService();
            tracedGenerateTextMock.mockRejectedValue(new Error('llm down'));
            const rule: Partial<IKodyRule> = { uuid: 'p', rule: LONG_TEXT };

            const result = await service.ensureSummaries([rule], orgData);

            expect(result[0].summary).toBeUndefined();
            expect(repository.updateRule).not.toHaveBeenCalled();
        });
    });
});
