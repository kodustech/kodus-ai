import {
    riskCriteriaInputSchema,
    riskCriteriaSchema,
} from '@libs/core/infrastructure/config/types/general/risk-assessment';
import { KODUS_RISK_RULE_IDS } from '@libs/core/infrastructure/config/types/general/risk-rule-ids';

// Rules Kodus stopped shipping, to pin how their overrides resolve.
jest.mock(
    '@libs/core/infrastructure/config/types/general/risk-rule-ids',
    () => {
        const actual = jest.requireActual(
            '@libs/core/infrastructure/config/types/general/risk-rule-ids',
        );
        const retired = ['kodus-retired', 'kodus-retired-edited'];
        return {
            ...actual,
            RETIRED_KODUS_RISK_RULE_IDS: retired,
            isKnownKodusRiskRuleId: (id: string) =>
                actual.isKnownKodusRiskRuleId(id) || retired.includes(id),
        };
    },
);

import { riskRulesFor } from './assess-pr-risk';
import {
    DEFAULT_RISK_CRITERIA,
    effectiveRiskCriteria,
} from './default-risk-criteria';

const ids = (rules: Array<{ id: string }>) => rules.map((rule) => rule.id);
const file = (filename: string) =>
    ({ filename, status: 'modified', additions: 1, deletions: 1 }) as any;

describe('effectiveRiskCriteria', () => {
    it('ships exactly the ids the config schema reserves', () => {
        expect(ids(DEFAULT_RISK_CRITERIA)).toEqual([...KODUS_RISK_RULE_IDS]);
    });

    it('is the Kodus defaults when the team set nothing', () => {
        const rules = effectiveRiskCriteria(undefined);
        expect(ids(rules)).toEqual(ids(DEFAULT_RISK_CRITERIA));
        expect(rules.every((rule) => rule.isDefault && rule.enabled)).toBe(
            true,
        );
    });

    it('applies a team override of a default by id, keeping what it leaves out', () => {
        const rules = effectiveRiskCriteria([
            { id: 'kodus-shared-contract', enabled: false },
            {
                id: 'kodus-ci-build',
                enabled: true,
                instructions: 'Only release workflows matter here.',
                includedFiles: ['.github/workflows/release*.yml'],
            },
        ]);
        const contract = rules.find((r) => r.id === 'kodus-shared-contract')!;
        expect(contract).toMatchObject({
            enabled: false,
            name: 'Shared contracts and public interfaces',
            isDefault: true,
        });
        expect(rules.find((r) => r.id === 'kodus-ci-build')).toMatchObject({
            name: 'CI, build, release and dependencies',
            instructions: 'Only release workflows matter here.',
            includedFiles: ['.github/workflows/release*.yml'],
        });
    });

    it('adds the team rules after the defaults and drops what cannot apply', () => {
        const rules = effectiveRiskCriteria([
            {
                id: 'tenant',
                name: 'Tenant isolation',
                enabled: true,
                instructions: 'Data must not cross tenants.',
            },
            // A default Kodus no longer ships: nothing to override, even
            // when the team had edited all of it.
            { id: 'kodus-retired', enabled: true },
            {
                id: 'kodus-retired-edited',
                name: 'Old rule',
                enabled: true,
                instructions: 'Stale wording.',
            },
            // A mistyped override changes nothing; the default stays on.
            { id: 'kodus-securty', enabled: false },
            // Not reachable through the schema; never sent half-built.
            { id: 'half', enabled: true } as any,
        ]);
        expect(ids(rules)).toEqual([...ids(DEFAULT_RISK_CRITERIA), 'tenant']);
        expect(rules.at(-1)).toMatchObject({ isDefault: false });
        expect(rules.find((r) => r.id === 'kodus-security')?.enabled).toBe(
            true,
        );
    });

    it('still applies a whole rule stored under an unknown kodus- id, as before the id was reserved', () => {
        const rules = effectiveRiskCriteria([
            {
                id: 'kodus-tenant',
                name: 'Tenant isolation',
                enabled: true,
                instructions: 'Data must not cross tenants.',
            },
        ]);
        expect(rules.at(-1)).toMatchObject({
            id: 'kodus-tenant',
            isDefault: false,
        });
    });
});

describe('riskCriteriaSchema', () => {
    it('accepts a default override with only what changes', () => {
        expect(
            riskCriteriaSchema.safeParse([
                { id: 'kodus-security', enabled: false },
            ]).success,
        ).toBe(true);
    });

    it('reads a stored kodus- id Kodus never shipped, but a save refuses it', () => {
        const stored = [{ id: 'kodus-securty', enabled: false }];
        expect(riskCriteriaSchema.safeParse(stored).success).toBe(true);
        const saved = riskCriteriaInputSchema.safeParse(stored);
        expect(saved.success).toBe(false);
        expect(saved.error?.issues[0].message).toMatch(
            /"kodus-securty" matches no Kodus risk rule/,
        );
        // Accepts what the assessment applies or drops on purpose.
        expect(
            riskCriteriaInputSchema.safeParse([
                { id: 'kodus-security', enabled: false },
                { id: 'kodus-retired', enabled: false },
                {
                    id: 'kodus-tenant',
                    name: 'Tenant isolation',
                    enabled: true,
                    instructions: 'Data must not cross tenants.',
                },
            ]).success,
        ).toBe(true);
    });

    it('requires a name and instructions for a team rule', () => {
        expect(
            riskCriteriaSchema.safeParse([{ id: 'tenant', enabled: true }])
                .success,
        ).toBe(false);
    });
});

describe('riskRulesFor', () => {
    it('sends enabled rules that match a changed file, naming the files of a scoped one', () => {
        const rules = riskRulesFor(
            [
                { id: 'kodus-money', enabled: false },
                {
                    id: 'fiscal',
                    name: 'Fiscal documents',
                    enabled: true,
                    instructions: 'The emitted XML must not change.',
                    includedFiles: ['app/Services/**'],
                },
                {
                    id: 'frontend',
                    name: 'Frontend',
                    enabled: true,
                    instructions: 'Checkout UI.',
                    includedFiles: ['web/**'],
                },
            ],
            [file('app/Services/Nfe.php'), file('README.md')],
        );
        expect(ids(rules)).not.toContain('kodus-money');
        expect(ids(rules)).not.toContain('frontend');
        expect(rules.find((rule) => rule.id === 'fiscal')).toEqual({
            id: 'fiscal',
            name: 'Fiscal documents',
            instructions: 'The emitted XML must not change.',
            files: ['app/Services/Nfe.php'],
        });
        expect(
            rules.find((rule) => rule.id === 'kodus-security'),
        ).not.toHaveProperty('files');
    });
});
