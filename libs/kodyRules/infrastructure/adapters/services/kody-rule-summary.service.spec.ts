import { KodyRuleSummaryService } from './kody-rule-summary.service';
import { LLM } from '@libs/llm/llm';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

/**
 * Pure-surface contract for the long-rule summary service: the hashing that
 * decides whether a cached summary/decomposition is still valid, and the
 * review-path swap that must NEVER serve a stale summary. No LLM, no DB — these
 * are the deterministic invariants a regression here would silently break
 * (a stale summary reaching the review = the model judging against outdated
 * rule text, with no error).
 */
describe('KodyRuleSummaryService — pure hashing & review-path resolution', () => {
    let service: KodyRuleSummaryService;

    beforeEach(() => {
        // The pure methods use only `this.hashOf` and constants; the injected
        // deps are never touched, so empty stand-ins are enough.
        service = new KodyRuleSummaryService(
            {} as any,
            {} as any,
            {} as any,
        );
    });

    const long = 'r'.repeat(1200);

    describe('isLong — the 1000-char threshold is exclusive', () => {
        it('is false AT 1000 chars and true just above it', () => {
            expect(service.isLong('a'.repeat(1000))).toBe(false);
            expect(service.isLong('a'.repeat(1001))).toBe(true);
        });

        it('treats null / undefined / empty as not long (never throws)', () => {
            expect(service.isLong(undefined)).toBe(false);
            expect(service.isLong(null)).toBe(false);
            expect(service.isLong('')).toBe(false);
        });
    });

    describe('hashOf', () => {
        it('is deterministic and distinguishes different inputs', () => {
            expect(service.hashOf('abc')).toBe(service.hashOf('abc'));
            expect(service.hashOf('abc')).not.toBe(service.hashOf('abd'));
        });

        it('hashes null / undefined as the empty string (never throws)', () => {
            const empty = service.hashOf('');
            expect(service.hashOf(undefined)).toBe(empty);
            expect(service.hashOf(null)).toBe(empty);
        });
    });

    describe('atomsHashOf — covers rule text AND examples', () => {
        it('changes when only the examples change (an example edit must invalidate atoms)', () => {
            const a = service.atomsHashOf({
                rule: 'R',
                examples: [{ snippet: 'x' }],
            } as any);
            const b = service.atomsHashOf({
                rule: 'R',
                examples: [{ snippet: 'y' }],
            } as any);
            expect(a).not.toBe(b);
        });

        it('is stable for identical rule + examples', () => {
            const r = { rule: 'R', examples: [{ snippet: 'x' }] } as any;
            expect(service.atomsHashOf(r)).toBe(service.atomsHashOf(r));
        });
    });

    describe('hasValidSummary', () => {
        it('is true only when content exists AND sourceHash matches the CURRENT rule text', () => {
            const valid = {
                rule: long,
                summary: { content: 'S', sourceHash: service.hashOf(long) },
            };
            expect(service.hasValidSummary(valid as any)).toBe(true);
        });

        it('is false when there is no summary content', () => {
            const noContent = {
                rule: long,
                summary: { sourceHash: service.hashOf(long) },
            };
            expect(service.hasValidSummary(noContent as any)).toBe(false);
        });

        it('is false when the rule text changed under the summary (stale hash)', () => {
            const stale = {
                rule: 'NEW rule text',
                summary: { content: 'S', sourceHash: service.hashOf('OLD rule text') },
            };
            expect(service.hasValidSummary(stale as any)).toBe(false);
        });
    });

    describe('hasValidAtoms', () => {
        it('is true only when items exist AND the atoms hash matches', () => {
            const base = { rule: 'R', examples: [{ snippet: 'x' }] };
            const valid = {
                ...base,
                atoms: { items: [{}], sourceHash: service.atomsHashOf(base as any) },
            };
            expect(service.hasValidAtoms(valid as any)).toBe(true);
        });

        it('is false when an example edit invalidated the decomposition', () => {
            const original = { rule: 'R', examples: [{ snippet: 'x' }] };
            const staleAtomsHash = service.atomsHashOf(original as any);
            const edited = {
                rule: 'R',
                examples: [{ snippet: 'EDITED' }],
                atoms: { items: [{}], sourceHash: staleAtomsHash },
            };
            expect(service.hasValidAtoms(edited as any)).toBe(false);
        });

        it('is false when there are no atom items', () => {
            const base = { rule: 'R', examples: [{ snippet: 'x' }] };
            const empty = {
                ...base,
                atoms: { items: [], sourceHash: service.atomsHashOf(base as any) },
            };
            expect(service.hasValidAtoms(empty as any)).toBe(false);
        });
    });

    describe('resolveForReview — the review-path swap (the correctness guard)', () => {
        it('swaps the rule text for the summary when long AND the summary matches', () => {
            const rule = {
                rule: long,
                summary: {
                    content: 'SHORT SUMMARY',
                    sourceHash: service.hashOf(long),
                },
            };
            const out = service.resolveForReview(rule as any);
            expect(out.rule).toBe('SHORT SUMMARY');
            expect(out).not.toBe(rule); // a copy, not a mutation of the input
        });

        it('returns the rule UNTOUCHED when it is not long', () => {
            const rule = {
                rule: 'short',
                summary: { content: 'S', sourceHash: service.hashOf('short') },
            };
            expect(service.resolveForReview(rule as any)).toBe(rule);
        });

        it('returns the rule UNTOUCHED when there is no summary', () => {
            const rule = { rule: long };
            expect(service.resolveForReview(rule as any)).toBe(rule);
        });

        it('NEVER serves a STALE summary — falls back to the full rule text and warns', () => {
            const warn = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => {});
            const rule = {
                rule: long,
                uuid: 'u1',
                summary: {
                    content: 'STALE SUMMARY',
                    // hash of some OTHER text → mismatch → stale
                    sourceHash: service.hashOf('a different, older rule body'),
                },
            };
            const out = service.resolveForReview(rule as any);
            expect(out.rule).toBe(long); // full text, NOT the stale summary
            expect(out.rule).not.toBe('STALE SUMMARY');
            expect(warn).toHaveBeenCalled(); // drift stays observable in prod
        });
    });
});

/**
 * Orchestration contract: generate()'s model-policy gate (the billing-safety
 * invariant — a post-trial org WITHOUT its own key must never silently burn
 * managed tokens) and its output validation, plus verifyAtoms()'s index guard.
 * LLM + permission service are stubbed; these assert the control flow around
 * the model call, not the model.
 */
describe('KodyRuleSummaryService — generate() model-policy gate & output validation', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const long = 'r'.repeat(1200);
    const GOOD_SUMMARY = 'WHAT TO VALIDATE:\n- x\nHOW TO VALIDATE:\n- y';

    let service: KodyRuleSummaryService;
    let resolveTaskSlot: jest.Mock;
    let getSubscriptionStatus: jest.Mock;
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        resolveTaskSlot = jest.fn();
        getSubscriptionStatus = jest.fn();
        service = new KodyRuleSummaryService(
            { resolveTaskSlot, getSubscriptionStatus } as any,
            {} as any,
            {} as any,
        );
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
        runSpy = jest.spyOn(LLM, 'run');
    });

    afterEach(() => jest.restoreAllMocks());

    it('short-circuits a non-long rule without resolving a model or calling the LLM', async () => {
        const out = await service.generate({ rule: 'short' } as any, ORG);
        expect(out).toBeNull();
        expect(resolveTaskSlot).not.toHaveBeenCalled();
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('SKIPS generation (no LLM call) for a post-trial org with no BYOK — billing safety', async () => {
        resolveTaskSlot.mockResolvedValue(undefined); // no BYOK slot
        getSubscriptionStatus.mockResolvedValue(SubscriptionStatus.ACTIVE); // post-trial
        runSpy.mockResolvedValue(GOOD_SUMMARY);

        const out = await service.generate({ rule: long, uuid: 'u1' } as any, ORG);

        expect(out).toBeNull();
        expect(runSpy).not.toHaveBeenCalled(); // must NOT burn managed tokens
    });

    it('PROCEEDS during trial without BYOK (managed default is allowed while trialing)', async () => {
        resolveTaskSlot.mockResolvedValue(undefined);
        getSubscriptionStatus.mockResolvedValue(SubscriptionStatus.TRIAL); // not post-trial
        runSpy.mockResolvedValue(GOOD_SUMMARY);

        const out = await service.generate({ rule: long, uuid: 'u1' } as any, ORG);

        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(out?.content).toContain('WHAT TO VALIDATE');
        expect(out?.sourceHash).toBe(service.hashOf(long)); // hashed from the exact text
    });

    it('runs on the resolved BYOK slot even post-trial (own key is always allowed)', async () => {
        const slot = { provider: 'openai', model: 'gpt-4o', apiKey: 'enc' } as any;
        resolveTaskSlot.mockResolvedValue(slot);
        getSubscriptionStatus.mockResolvedValue(SubscriptionStatus.ACTIVE);
        runSpy.mockResolvedValue(GOOD_SUMMARY);

        const out = await service.generate({ rule: long, uuid: 'u1' } as any, ORG);

        expect(out).not.toBeNull();
        expect(runSpy).toHaveBeenCalledWith(
            expect.objectContaining({ byokConfig: slot }),
        );
    });

    it('DISCARDS output missing the required WHAT/HOW sections (returns null)', async () => {
        resolveTaskSlot.mockResolvedValue(undefined);
        getSubscriptionStatus.mockResolvedValue(SubscriptionStatus.TRIAL);
        runSpy.mockResolvedValue('here is a summary with no required headers');

        expect(
            await service.generate({ rule: long, uuid: 'u1' } as any, ORG),
        ).toBeNull();
    });

    it('is fail-soft: an LLM error yields null (caller falls back to full rule text)', async () => {
        resolveTaskSlot.mockResolvedValue(undefined);
        getSubscriptionStatus.mockResolvedValue(SubscriptionStatus.TRIAL);
        runSpy.mockRejectedValue(new Error('provider 500'));

        expect(
            await service.generate({ rule: long, uuid: 'u1' } as any, ORG),
        ).toBeNull();
    });
});

describe('KodyRuleSummaryService — verifyAtoms() index guard', () => {
    let service: KodyRuleSummaryService;
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        service = new KodyRuleSummaryService({} as any, {} as any, {} as any);
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
        runSpy = jest.spyOn(LLM, 'run');
    });

    afterEach(() => jest.restoreAllMocks());

    it('returns empty (no LLM call) when there are no atoms to verify', async () => {
        const out = await (service as any).verifyAtoms(
            { rule: 'R' },
            [],
            undefined,
            { organizationId: 'o' },
        );
        expect(out.invalidIndexes.size).toBe(0);
        expect(out.missingRequirements).toEqual([]);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('drops indexes the model returns that were never sent (never risk dropping the wrong atom)', async () => {
        // Two atoms sent (indexes 0 and 1). The model echoes a valid 0 and a
        // bogus 99 — 99 must be ignored, not applied to some other atom.
        runSpy.mockResolvedValue({
            invalidAtoms: [
                { index: 0, reason: 'inverted polarity' },
                { index: 99, reason: 'ghost' },
            ],
            missingRequirements: ['coverage gap'],
        });

        const out = await (service as any).verifyAtoms(
            { rule: 'R' },
            [{ title: 'a', spec: 's' }, { title: 'b', spec: 's' }],
            undefined,
            { organizationId: 'o' },
        );

        expect(out.invalidIndexes.get(0)).toBe('inverted polarity');
        expect(out.invalidIndexes.has(99)).toBe(false); // out-of-range dropped
        expect(out.missingRequirements).toEqual(['coverage gap']);
    });
});

/**
 * ensureSummaries() lazy backfill: it must generate ONLY for rules that need it,
 * attach the fresh summary so the CURRENT review already benefits, persist it,
 * and — the whole point — degrade to in-memory on every persistence failure so a
 * review is never blocked. generate() is stubbed (tested above); these pin the
 * orchestration around it.
 */
describe('KodyRuleSummaryService — ensureSummaries() backfill orchestration', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const long = 'r'.repeat(1200);

    let service: KodyRuleSummaryService;
    let findByOrganizationId: jest.Mock;
    let updateRule: jest.Mock;
    let genSpy: jest.SpyInstance;

    const summary = () =>
        ({
            content: 'SUM',
            sourceHash: 'hash',
            generatedAt: undefined,
            model: 'm',
        }) as any;

    beforeEach(() => {
        findByOrganizationId = jest.fn().mockResolvedValue({ uuid: 'doc-1' });
        updateRule = jest.fn().mockResolvedValue(undefined);
        service = new KodyRuleSummaryService(
            {} as any,
            { findByOrganizationId, updateRule } as any,
            {} as any,
        );
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
        genSpy = jest.spyOn(service, 'generate');
    });

    afterEach(() => jest.restoreAllMocks());

    it('does nothing (no generate, no DB) when no rule needs a summary', async () => {
        const rules = [{ uuid: 'r2', rule: 'short' }] as any; // not long → not pending
        const out = await service.ensureSummaries(rules, ORG);

        expect(out).toBe(rules); // same array, untouched
        expect(genSpy).not.toHaveBeenCalled();
        expect(findByOrganizationId).not.toHaveBeenCalled();
    });

    it('generates ONLY for pending rules; leaves short/already-summarized ones untouched', async () => {
        const valid = {
            uuid: 'r3',
            rule: long,
            summary: { content: 'S', sourceHash: service.hashOf(long) },
        } as any;
        const short = { uuid: 'r2', rule: 'short' } as any;
        const pending = { uuid: 'r1', rule: long } as any;
        const s1 = summary();
        genSpy.mockResolvedValue(s1);

        const out = await service.ensureSummaries([valid, short, pending], ORG);

        expect(genSpy).toHaveBeenCalledTimes(1); // only the pending one
        expect(out.find((r) => r.uuid === 'r1')?.summary).toBe(s1);
        expect(out.find((r) => r.uuid === 'r3')).toBe(valid); // untouched ref
        expect(out.find((r) => r.uuid === 'r2')).toBe(short); // untouched ref
    });

    it('attaches the fresh summary in-memory AND persists it with the doc uuid', async () => {
        const s1 = summary();
        genSpy.mockResolvedValue(s1);

        const out = await service.ensureSummaries([{ uuid: 'r1', rule: long } as any], ORG);

        expect(out[0].summary).toBe(s1); // current review benefits immediately
        expect(updateRule).toHaveBeenCalledWith('doc-1', 'r1', { summary: s1 });
    });

    it('degrades to in-memory when PERSIST fails — the summary is still returned, no throw', async () => {
        genSpy.mockResolvedValue(summary());
        updateRule.mockRejectedValue(new Error('db write failed'));

        const out = await service.ensureSummaries([{ uuid: 'r1', rule: long } as any], ORG);

        expect(out[0].summary).toBeDefined(); // review not blocked by a failed write
    });

    it('degrades to in-memory when the DOC lookup fails — summary used, persist skipped', async () => {
        findByOrganizationId.mockRejectedValue(new Error('no doc'));
        genSpy.mockResolvedValue(summary());

        const out = await service.ensureSummaries([{ uuid: 'r1', rule: long } as any], ORG);

        expect(out[0].summary).toBeDefined();
        expect(updateRule).not.toHaveBeenCalled(); // docUuid null → no persist attempt
    });

    it('leaves a rule untouched when generation yields nothing (fall back to full text)', async () => {
        genSpy.mockResolvedValue(null);
        const input = { uuid: 'r1', rule: long } as any;

        const out = await service.ensureSummaries([input], ORG);

        expect(out[0]).toBe(input); // same ref, no summary attached
        expect(out[0].summary).toBeUndefined();
        expect(updateRule).not.toHaveBeenCalled();
    });
});
