import * as yaml from 'js-yaml';

import { formatRuleToYaml } from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import {
    KodyRulesExampleDto,
    KodyRulesInheritanceDto,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('formatRuleToYaml — enabled field', () => {
    const base = { title: 'No console.log', rule: 'Do not commit console.log' };

    it('omits enabled for an active rule (active files unchanged)', () => {
        const parsed = yaml.load(
            formatRuleToYaml({ ...base, status: KodyRulesStatus.ACTIVE }),
        ) as Record<string, unknown>;
        expect('enabled' in parsed).toBe(false);
    });

    it('omits enabled when status is absent', () => {
        const parsed = yaml.load(formatRuleToYaml(base)) as Record<
            string,
            unknown
        >;
        expect('enabled' in parsed).toBe(false);
    });

    it('emits enabled: false for a paused rule', () => {
        const parsed = yaml.load(
            formatRuleToYaml({ ...base, status: KodyRulesStatus.PAUSED }),
        ) as Record<string, unknown>;
        expect(parsed.enabled).toBe(false);
    });
});

describe('formatRuleToYaml — Nest class instances', () => {
    const base = { title: 'No console.log', rule: 'Do not commit console.log' };

    it('dumps examples that are KodyRulesExampleDto class instances', () => {
        const example = new KodyRulesExampleDto();
        example.snippet = 'if (value == null) return;';
        example.isCorrect = false;

        const parsed = yaml.load(
            formatRuleToYaml({ ...base, examples: [example] }),
        ) as {
            examples: Array<{ snippet: string; isCorrect: boolean }>;
        };

        expect(parsed.examples).toEqual([
            { snippet: 'if (value == null) return;', isCorrect: false },
        ]);
    });

    it('dumps inheritance that is a KodyRulesInheritanceDto class instance', () => {
        const inheritance = new KodyRulesInheritanceDto();
        inheritance.inheritable = true;
        inheritance.include = ['src/**'];
        inheritance.exclude = ['src/legacy/**'];

        const parsed = yaml.load(
            formatRuleToYaml({ ...base, inheritance }),
        ) as {
            inheritance: {
                inheritable: boolean;
                include: string[];
                exclude: string[];
            };
        };

        expect(parsed.inheritance).toEqual({
            inheritable: true,
            include: ['src/**'],
            exclude: ['src/legacy/**'],
        });
    });
});
