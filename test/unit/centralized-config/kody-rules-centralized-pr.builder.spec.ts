import * as yaml from 'js-yaml';

import { formatRuleToYaml } from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
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
