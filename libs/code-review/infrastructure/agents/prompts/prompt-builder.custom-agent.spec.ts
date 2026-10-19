/**
 * #2172 — custom agents keep to their lane, and the custom agents of one
 * review share a system-prompt prefix the provider can cache. The generalist
 * (and every built-in agent) renders byte for byte what it rendered before.
 */
import { createHash } from 'node:crypto';

import {
    buildSystemPrompt,
    buildUserPrompt,
    hasOwnLane,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import { verifierPromptFor } from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { buildVerifierPrompt } from '@libs/code-review/infrastructure/agents/prompts/verifier-prompt';
import { CACHE_PREFIX_BOUNDARY } from '@libs/llm/prompt-cache-boundary';

const generalist: PromptAgentMeta = {
    identity: {
        name: 'kodus-generalist-review-agent',
        description: 'finds bugs, security and performance issues',
        goal: 'g',
        expertise: ['x'],
    },
    categoryPrompt: '<Category>generalist</Category>',
    categoryLabel: 'generalist',
    allowedLabels: ['bug', 'security', 'performance'],
    supportsMixed: true,
    knowledgeSection: '<TeamKnowledge>skills</TeamKnowledge>',
};

const input = (over: any = {}): any => ({
    remoteCommands: {},
    changedFiles: [
        {
            filename: 'src/pagination.ts',
            patch: '@@ -1 +1,2 @@\n+const x = 1;',
        },
    ],
    languageResultPrompt: 'pt-BR',
    prTitle: 't',
    prBody: 'b',
    memoryRules: [{ title: 'r', rule: 'do x' }],
    commits: [{ sha: 'abcdef123456', message: 'feat: x', date: '2026-01-01' }],
    linkedRepoAccess: {
        list: () => [{ repository: 'o/r', preferredRef: 'main' }],
    },
    ...over,
});

const customAgent = (
    name: string,
    instructions: string,
    over: Partial<PromptAgentMeta> = {},
): PromptAgentMeta => ({
    identity: {
        name: `kodus-custom-agent-${name.toLowerCase().replace(/\W+/g, '-')}`,
        description: `Team-defined reviewer "${name}".`,
        goal: 'g',
        expertise: [name],
    },
    categoryPrompt: `  <Mission>You are the team's "${name}" reviewer.</Mission>\n  <TeamInstructions>\n${instructions}\n  </TeamInstructions>`,
    categoryLabel: 'custom_agent',
    allowedLabels: ['bug'],
    supportsMixed: false,
    conventionGuides: [],
    ...over,
});

const e2e = customAgent(
    'Booking E2E',
    'Every new booking screen needs an end-to-end test under e2e/bookings.',
);
const security = customAgent(
    'Booking Security',
    'Flag booking endpoints that skip the tenant check.',
    {
        conventionGuides: ['.skills/tenancy/SKILL.md'],
        knowledgeSection: '<TeamKnowledge>tenancy skill</TeamKnowledge>',
    },
);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const commonPrefixLength = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
};

beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(new Date('2026-01-15T12:00:00Z'));
});

afterAll(() => {
    jest.useRealTimers();
});

describe('generalist prompts are byte-identical', () => {
    // sha256 of the prompts rendered on feat/custom-agents@d80afe38d (before
    // the lane and prefix changes) for this exact input.
    const BASE: Record<string, [any, string, string]> = {
        full: [
            input(),
            '4f67236a90cbf50ee3b36e581d2cc5f650253582b3897a6bf54a3b79f836c2bc',
            '98ffa8eff25172be473cd935a6036243fc57daf863e6e45dd337e667851c2ed5',
        ],
        compact: [
            input({ adaptiveProfile: { compactPrompt: true } }),
            '86b1a846139d9cd01beacc770af75096c5147cbaa3d6fb9a19adaf91795ebca8',
            'fba3bbef6f6628472d0e6eb806c4f869b57df6b0865789270331adc12b850014',
        ],
        selfContained: [
            input({ remoteCommands: undefined }),
            '52544dd1089b0f5cd65fc9fbb8f7322a3ce975de19a4678b25717a30d255f979',
            '06a58f11c5e2f617fcfd0893d009cef63bbf08a30a98ee0b88b28a5e6ba2c2f7',
        ],
        withGraph: [
            input({
                callGraph: '<CallGraph>g</CallGraph>',
                reviewDirective: 'auth',
                linkedRepoAccess: undefined,
            }),
            '620249378123462aa69c5bccb81387f05955ccb75a928344a8fa55ddc6ea0134',
            '63e7e9dc665c9953f1796d2659c5eb1a548d172ca9da7f51eba0da0744bea180',
        ],
    };

    it.each(Object.entries(BASE))(
        '%s system and user prompt',
        (_name, [given, systemSha, userSha]) => {
            expect(sha(buildSystemPrompt(given, generalist))).toBe(systemSha);
            expect(sha(buildUserPrompt(given, generalist))).toBe(userSha);
        },
    );

    it('the HV2 verifier prompts', () => {
        const finding: any = {
            relevantFile: 'src/pagination.ts',
            relevantLinesStart: 8,
            relevantLinesEnd: 9,
            severity: 'high',
            suggestionContent: 'off by one',
            existingCode: 'i <= n',
        };
        expect(sha(buildVerifierPrompt('', 0).system)).toBe(
            '729e28d05c1ed5b41ec346dee92540a996ee99230cb396ac55bd6f4ad1d9a428',
        );
        expect(sha(verifierPromptFor(finding))).toBe(
            'da4772491f4b1a711f9f3c38413f19acc0d60288bc6d1a7fa0a52a4a306fa568',
        );
    });

    it('carries no shared-prefix marker', () => {
        expect(buildSystemPrompt(input(), generalist)).not.toContain(
            CACHE_PREFIX_BOUNDARY,
        );
        expect(hasOwnLane(generalist)).toBe(false);
    });
});

describe('custom agent — lane focus', () => {
    it('replaces the defect hunt with a hunt scoped to its focus', () => {
        const system = buildSystemPrompt(input(), e2e);

        expect(hasOwnLane(e2e)).toBe(true);
        expect(system).toContain(
            'The generalist reviewer already covers general correctness bugs on it.',
        );
        expect(system).toContain('Report only findings within your focus');
        expect(system).toContain(
            'Do not trace call chains or hunt for defects your focus does not cover.',
        );
        expect(system).not.toContain(
            'Assume every change is broken until you prove it is safe.',
        );
        expect(system).not.toContain('High-recall mode');
        // The evidence discipline stays.
        expect(system).toContain('IMPORTANT — VERIFY BEFORE CLAIMING:');
        expect(system).toContain('give a one-line certificate');
        expect(system).toContain(
            'Root cause must be in lines added or modified by this PR.',
        );
        expect(system).toContain(
            'Every new booking screen needs an end-to-end test',
        );
    });

    it('scopes the task and the reporting rules of its user prompt', () => {
        const user = buildUserPrompt(input(), e2e);

        expect(user).toContain(
            'Review this Pull Request for the issues your focus covers',
        );
        expect(user).toContain('Report only findings within your focus.');
        expect(user).not.toContain('Reporting threshold (high-recall)');
        expect(user).not.toContain(
            'Missing defensive measures (CSRF, rate limiting, input validation)',
        );
        expect(user).toContain('<Diffs>');
        expect(user).toContain('Assign a confidence score (1-10)');
    });

    it('scopes the compact prompt too, and keeps its instructions there', () => {
        const compact = input({ adaptiveProfile: { compactPrompt: true } });
        const system = buildSystemPrompt(compact, e2e);

        expect(system).toContain('Report only findings within your focus');
        expect(system).toContain(
            'Every new booking screen needs an end-to-end test',
        );
        expect(system).not.toContain('Default to reporting');
        expect(buildUserPrompt(compact, e2e)).not.toContain(
            'Reporting threshold (high-recall)',
        );
    });
});

describe('custom agent — shared system-prompt prefix', () => {
    it('two custom agents share everything up to their Role', () => {
        const a = buildSystemPrompt(input(), e2e);
        const b = buildSystemPrompt(input(), security);
        const boundaryEnd =
            a.indexOf(CACHE_PREFIX_BOUNDARY) + CACHE_PREFIX_BOUNDARY.length;

        expect(a.indexOf(CACHE_PREFIX_BOUNDARY)).toBe(
            b.indexOf(CACHE_PREFIX_BOUNDARY),
        );
        // The prefix is the whole static block: date, mindset, workflow, scope.
        expect(commonPrefixLength(a, b)).toBeGreaterThanOrEqual(boundaryEnd);
        expect(boundaryEnd).toBeGreaterThan(4000);
        const prefix = a.slice(0, boundaryEnd);
        expect(prefix).toContain('<Date>15/01/2026</Date>');
        expect(prefix).toContain('</Workflow>');
        expect(prefix).toContain('</Scope>');
        // Nothing that names the agent is in it.
        expect(prefix).not.toContain('Booking');
        expect(prefix).not.toContain('kodus-custom-agent');
        expect(prefix).not.toContain('  <Role>\n');
        // What names the agent comes right after.
        expect(a.slice(boundaryEnd)).toMatch(
            /^\n {2}<Role>\n {4}You are kodus-custom-agent-booking-e2e/,
        );
        expect(b).toContain('tenancy skill');
    });

    it('the compact prompts share their prefix too', () => {
        const compact = input({ adaptiveProfile: { compactPrompt: true } });
        const a = buildSystemPrompt(compact, e2e);
        const b = buildSystemPrompt(compact, security);
        const boundaryEnd =
            a.indexOf(CACHE_PREFIX_BOUNDARY) + CACHE_PREFIX_BOUNDARY.length;

        expect(boundaryEnd).toBeGreaterThan(CACHE_PREFIX_BOUNDARY.length);
        expect(commonPrefixLength(a, b)).toBeGreaterThanOrEqual(boundaryEnd);
    });
});
