import { KodyRuleSummaryService } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { buildDetectorCandidates } from './kody-rules-detector.compiler';
import { judgeKodyRulesSharded, RunJudge } from './kody-rules-sharded.judge';
import { reviewUnitKey } from '@libs/common/utils/kody-rules/review-unit';

jest.mock('@libs/core/log/logger', () => {
    const spy = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    };
    return { createLogger: () => spy };
});

const PARENT_TITLE = 'Parent rule title';

// The diff of the issue's repro: only `console.log(a);` is added, at line 2.
const file = (filename: string, patch: string): any => ({
    filename,
    status: 'modified',
    patch,
    patchWithLinesStr: patch,
});

const CONSOLE_LOG_FILE = file('src/a.ts', '1 const a = 1;\n2 +console.log(a);');

/**
 * A long rule decomposed into three atoms: one whose own detector matches the
 * file, one whose detector matches nothing in it, and one with no detector at
 * all (semantic). Every unit carries the PARENT uuid, which is the whole point
 * of #2509.
 */
function atomUnits() {
    const service = new KodyRuleSummaryService({} as any, {} as any, {} as any);
    const parent: any = {
        uuid: 'parent-1',
        title: PARENT_TITLE,
        rule: 'x'.repeat(1001),
        scope: KodyRulesScope.FILE,
        status: 'active',
        severity: 'high',
        examples: [],
        atoms: {
            items: [
                {
                    id: 'parent-1-atom-1',
                    title: 'Console log',
                    spec: 'WHAT: no console.log',
                    detector: { type: 'regex', pattern: 'console\\.log' },
                },
                {
                    id: 'parent-1-atom-2',
                    title: 'No debugger',
                    spec: 'WHAT: no debugger statement',
                    detector: { type: 'regex', pattern: '\\bdebugger\\b' },
                },
                {
                    id: 'parent-1-atom-3',
                    title: 'No eval',
                    spec: 'WHAT: no eval',
                },
            ],
        },
    };
    parent.atoms.sourceHash = service.atomsHashOf(parent);
    parent.atoms.generatedAt = new Date();
    parent.atoms.model = 'm';
    return service.expandForReview(parent);
}

const decision = {
    suggestionId: 's-1',
    relevantFile: 'src/a.ts',
    relevantLinesStart: 2,
    relevantLinesEnd: 2,
    suggestionContent: 'Remove the console.log',
    label: 'kody_rules',
    brokenKodyRulesIds: ['parent-1'],
    outcome: 'not_implemented',
} as any;

describe('a decomposed rule is judged unit by unit, not once per detector (#2509)', () => {
    it('keeps the parent uuid on every atom and gives each unit its own key', () => {
        const units = atomUnits();

        expect(units.map((u) => u.uuid)).toEqual([
            'parent-1',
            'parent-1',
            'parent-1',
        ]);
        expect(units.map((u) => reviewUnitKey(u))).toEqual([
            'parent-1-atom-1',
            'parent-1-atom-2',
            'parent-1-atom-3',
        ]);
        expect(units.map((u) => u.parentTitle)).toEqual([
            PARENT_TITLE,
            PARENT_TITLE,
            PARENT_TITLE,
        ]);
    });

    it('indexes detector hits per atom, so one atom cannot hit for its siblings', () => {
        const units = atomUnits();
        const index = buildDetectorCandidates(
            units.filter((u) => u.detector),
            [CONSOLE_LOG_FILE],
        );

        expect([...index.keys()]).toEqual(['parent-1-atom-1']);
        expect(index.get('parent-1-atom-1')?.get('src/a.ts')).toEqual([2]);
        // The rule's uuid is not a unit key any more: the sibling detectors ran
        // and one of them matched nothing, so nothing may be filed under it.
        expect(index.get('parent-1')).toBeUndefined();
    });

    it('judges the atom whose detector matched and drops the one that did not', async () => {
        const units = atomUnits();
        const detectorHits = buildDetectorCandidates(
            units.filter((u) => u.detector),
            [CONSOLE_LOG_FILE],
        );
        const prompts: string[] = [];
        const run: RunJudge = async ({ user }) => {
            prompts.push(user);
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles: [CONSOLE_LOG_FILE],
            rules: units,
            runJudge: run,
            detectorHits,
            previousDecisions: [decision],
        });

        expect(prompts).toHaveLength(1);
        // The atom with no detector is semantic: always judged.
        expect(prompts[0]).toContain('[1] Console log');
        expect(prompts[0]).toContain('No eval');
        // `\bdebugger\b` fired nowhere in this file, so that atom is not judged
        // on it. Before #2509 the sibling's hit kept it in the shard.
        expect(prompts[0]).not.toContain('No debugger');
    });

    it('lists a candidate line only for the atom whose detector flagged it', async () => {
        const units = atomUnits();
        const detectorHits = buildDetectorCandidates(
            units.filter((u) => u.detector),
            [CONSOLE_LOG_FILE],
        );
        const prompts: string[] = [];
        const run: RunJudge = async ({ user }) => {
            prompts.push(user);
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles: [CONSOLE_LOG_FILE],
            rules: units,
            runJudge: run,
            detectorHits,
        });

        expect(prompts[0]).toContain('<Candidates>');
        expect(prompts[0]).toContain('- rule [1] -> line(s) 2');
        expect(prompts[0]).not.toContain('- rule [2] -> line(s)');
    });

    it('names an earlier decision after the rule, not after its last atom', async () => {
        const units = atomUnits();
        const prompts: string[] = [];
        const run: RunJudge = async ({ user }) => {
            prompts.push(user);
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles: [CONSOLE_LOG_FILE],
            rules: units,
            runJudge: run,
            previousDecisions: [decision],
        });

        expect(prompts[0]).toContain(`Kody Rule — "${PARENT_TITLE}"`);
        expect(prompts[0]).not.toContain('"No eval"');
        // Same name in the rule list, or the judge reads the decision as being
        // about a rule that is not in front of it.
        expect(prompts[0]).toContain(`part of rule: ${PARENT_TITLE}`);
    });

    it('keeps a keyless unit and an undecomposed rule judged, beside the atoms', async () => {
        // Both control cases below pass on the pre-fix revision on their own, so
        // they are asserted in the same run as the atoms: the sibling-atom
        // assertion is what fails without the per-unit key, and it drags these
        // two along instead of letting them pin nothing.
        const keyless: any = {
            title: 'Keyless console.log rule',
            rule: 'no console.log',
            scope: KodyRulesScope.FILE,
            detector: { type: 'regex', pattern: 'console\\.log' },
        };
        const plain: any = {
            uuid: 'r1',
            title: 'Plain console.log rule',
            rule: 'no console.log',
            scope: KodyRulesScope.FILE,
            detector: { type: 'regex', pattern: 'console\\.log' },
        };
        const units = [...atomUnits(), keyless, plain];
        const detectorHits = buildDetectorCandidates(
            units.filter((u) => u.detector),
            [CONSOLE_LOG_FILE],
        );
        const prompts: string[] = [];
        const run: RunJudge = async ({ user }) => {
            prompts.push(user);
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles: [CONSOLE_LOG_FILE],
            rules: units,
            runJudge: run,
            detectorHits,
        });

        // A rule that was never decomposed keeps indexing under its own uuid.
        expect(detectorHits.has('r1')).toBe(true);
        expect(prompts).toHaveLength(1);
        // A keyless unit (`buildDetectorCandidates` can never file a hit for it)
        // is judged everywhere, as it was before keying changed: dropping it
        // would lose the rule without a trace.
        expect(prompts[0]).toContain('Keyless console.log rule');
        expect(prompts[0]).toContain('Plain console.log rule');
        // And the atom whose detector fired nowhere is still absent.
        expect(prompts[0]).not.toContain('No debugger');
    });
});
