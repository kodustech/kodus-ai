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
import { ONE_PROBLEM_RULE } from '@libs/code-review/infrastructure/agents/prompts/one-problem-rule';

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
    // User, self-contained and verifier hashes re-pinned to the lean finder
    // output (#1821): no confidence, severity or code fields.
    const BASE: Record<string, [any, string, string]> = {
        full: [
            input(),
            '4f67236a90cbf50ee3b36e581d2cc5f650253582b3897a6bf54a3b79f836c2bc',
            'a87059b88ead0443c616f9eb7e01a4267fec13f29e5621fa790ab41f67cae415',
        ],
        compact: [
            input({ adaptiveProfile: { compactPrompt: true } }),
            '86b1a846139d9cd01beacc770af75096c5147cbaa3d6fb9a19adaf91795ebca8',
            '1d7576e6b150abadbe64cc14c7026ec10c40ec4d509fbcf345d109ef56a518c3',
        ],
        selfContained: [
            input({ remoteCommands: undefined }),
            '1a0ab95066aa28cc16edb771023dc5e6890f86e95460d89c9c9d36ecf04f2cf8',
            '238ac474c348a8c31ac349bf2a9755ab554a914770c56b42fdf4b68d7dd16178',
        ],
        withGraph: [
            input({
                callGraph: '<CallGraph>g</CallGraph>',
                reviewDirective: 'auth',
                linkedRepoAccess: undefined,
            }),
            '620249378123462aa69c5bccb81387f05955ccb75a928344a8fa55ddc6ea0134',
            '091df947ff61a92c6f70436edf6deaa0ee75fe16965985b7520ec6fa622c9442',
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
            '1d3f9702fc3ce50d26861faf9840d6b57223575f2ac049179d6e4765d1f5c6f1',
        );
        expect(sha(verifierPromptFor(finding))).toBe(
            'aca7d794ff9c6fa75df3ffde90a4be8090b9ec2f4bc7b0d0dc200df49dec934a',
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
        expect(user).toContain(`- ${ONE_PROBLEM_RULE}`);
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

describe('custom agent — conflicting sources', () => {
    const CONFLICT = 'When two sources give conflicting rules for this code';

    it('asks an agent with guides to name the disagreement, not pick silently', () => {
        for (const given of [
            input(),
            input({ adaptiveProfile: { compactPrompt: true } }),
        ]) {
            const system = buildSystemPrompt(given, security);
            expect(system).toContain(CONFLICT);
            expect(system).toContain('never apply one silently');
            expect(system).toContain('report the conflict itself');
        }
    });

    it('stays out of the prompts of an agent without guides and of the generalist', () => {
        expect(buildSystemPrompt(input(), e2e)).not.toContain(CONFLICT);
        expect(buildSystemPrompt(input(), generalist)).not.toContain(CONFLICT);
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
