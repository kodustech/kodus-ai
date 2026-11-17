import { type ReportPath, type RuntimeRunReport, RuntimeRunReportSchema } from '@libs/runtime/run';

import {
    checkOf,
    code,
    formatDuration,
    formatUtcTime,
    hasCommentMarker,
    partlyTestedReasons,
    renderBareCheckOutput,
    renderCheckOutput,
    renderProgressComment,
    renderReportComment,
    renderSuggestionReply,
    renderUndeliveredReportComment,
    previewLinks,
    runtimeLinks,
    RUNTIME_COMMENT_MARKER,
    usualDuration,
    withCommentMarker,
} from './render-runtime-comment';

const RUN = '0b9f4c1e-8d2a-4f6b-9a3c-1e2d3f4a5b6c';
const links = runtimeLinks('https://app.kodus.test/', { runId: RUN, repositoryId: 'repo-1' });
const RUN_URL = `https://app.kodus.test/runtime/runs/${RUN}`;

function report(patch: Partial<RuntimeRunReport> = {}): RuntimeRunReport {
    return {
        state: 'regression',
        verdictState: 'regression',
        headSha: 'a1b2c3d'.padEnd(40, '0'),
        requestedAt: '2026-10-31T14:00:00.000Z',
        trigger: 'pull_request',
        bootMs: 108_000,
        paths: [
            {
                entryPoint: 'POST /orders',
                probeId: 'empty-cart',
                verdict: 'finding',
                findingKind: 'behavior_change',
                intent: 'unintended',
                base: { status: 400 },
                pr: { status: 500 },
                suggestionId: 'sug-1',
            },
            {
                entryPoint: 'GET /orders',
                probeId: 'list-orders',
                verdict: 'not_reproduced',
                base: { status: 200 },
                pr: { status: 200 },
            },
        ],
        uncovered: [{ entryPoint: 'POST /payments', reason: 'blocker', blocker: { kind: 'missing_env', name: 'STRIPE_TEST_KEY' } }],
        blockedOutbound: [],
        commands: 14,
        machinesDestroyed: true,
        cellOwner: 'kodus',
        ...patch,
    };
}

describe('runtimeLinks', () => {
    it('builds dashboard links and nothing from a missing or odd base URL', () => {
        expect(links).toEqual({ run: RUN_URL, settings: 'https://app.kodus.test/settings/code-review/repo-1/kody-runtime' });
        expect(runtimeLinks(undefined, { runId: RUN, repositoryId: 'r' })).toEqual({});
        expect(runtimeLinks('javascript:alert(1)', { runId: RUN, repositoryId: 'r' })).toEqual({});
    });
});

describe('code (untrusted text)', () => {
    it('keeps Runtime text inside one inline code span: no link, image, mention or new block', () => {
        expect(code('POST /orders')).toBe('`POST /orders`');
        expect(code('a`b\n## title')).toBe('`a b ## title`');
        expect(code('x'.repeat(300))).toHaveLength(122);
    });

    it('formats durations like the product', () => {
        expect(formatDuration(4_000)).toBe('4s');
        expect(formatDuration(108_000)).toBe('1m 48s');
        expect(formatDuration(120_000)).toBe('2m');
        expect(formatDuration(undefined)).toBeUndefined();
    });
});

describe('renderProgressComment (screen 6)', () => {
    const at = { requestedAt: '2026-10-31T14:00:00.000Z', startedAt: '2026-10-31T14:00:05.000Z' };

    it('marks done, current and pending phases, says when it started and links to the live Run', () => {
        const body = renderProgressComment(
            {
                phase: 'testing',
                ...at,
                trigger: 'pull_request',
                bootMs: 108_000,
                applyMs: 4_000,
                tested: { done: 2, total: 3 },
                regressions: 1,
            },
            links,
        );
        expect(body).toBe(
            [
                '### Kody Runtime · running',
                '',
                'Started at 14:00 UTC because this pull request was opened or updated.',
                '',
                '- ✓ Started main · 1m 48s',
                '- ✓ Started this pull request · 4s',
                '- ◐ Evaluating probes · 2 of 3 done · 1 regression so far',
                '- ○ Writing the report',
                '',
                `Kody edits this comment when a step ends, not in between. [Watch live in Kodus](${RUN_URL})`,
            ].join('\n'),
        );
    });

    it('the first phase has nothing done yet and no link without a dashboard URL', () => {
        const body = renderProgressComment({ phase: 'booting', ...at }, {});
        expect(body).toContain('- ◐ Starting main and this pull request in isolated machines');
        expect(body).toContain('- ○ Building and starting this pull request');
        expect(body).toContain('- ○ Evaluating probes');
        expect(body).toContain('Started at 14:00 UTC.');
        expect(body).toContain('not in between. Watch live in Kodus');
        expect(body).not.toContain('](');
    });

    it('a long phase says how long it usually takes on this environment', () => {
        const body = renderProgressComment(
            { phase: 'applying', ...at, trigger: 'pull_request', bootMs: 108_000, estimates: { bootMs: 100_000, applyMs: 470_000 } },
            links,
        );
        expect(body).toContain('- ✓ Started main · 1m 48s');
        expect(body).toContain('- ◐ Building and starting this pull request · usually ~8 min');
        // Only the current phase carries an estimate: a done one shows what it took.
        expect(body).not.toContain('usually ~2 min');
    });

    it('says nothing about duration without an estimate, and under a minute for a short one', () => {
        expect(renderProgressComment({ phase: 'booting', ...at }, links)).not.toContain('usually');
        expect(renderProgressComment({ phase: 'booting', ...at, estimates: { bootMs: 20_000 } }, links)).toContain(
            '- ◐ Starting main and this pull request in isolated machines · usually under a minute',
        );
    });

    it('once the probe phase is done, the line counts outcomes', () => {
        const body = renderProgressComment({ phase: 'reporting', ...at, tested: { done: 3, total: 3 }, regressions: 0 }, links);
        expect(body).toContain('- ✓ Evaluated probes · 3 probe outcomes');
        expect(body).toContain('- ◐ Writing the report');
    });

    it('formats the start as UTC and estimates in whole minutes', () => {
        expect(formatUtcTime('2026-10-31T23:59:59.000Z')).toBe('23:59 UTC');
        expect(formatUtcTime('nope')).toBeUndefined();
        expect(usualDuration(470_000)).toBe('usually ~8 min');
        expect(usualDuration(59_000)).toBe('usually under a minute');
        expect(usualDuration(undefined)).toBeUndefined();
    });
});

describe('renderReportComment (screen 7)', () => {
    it('shows inconclusive probe outcomes without claiming requests ran when reset failed', () => {
        // Run 1: reset failed before any probe.run; the report still has one outcome per planned probe.
        const resetLost = report({
            state: 'partly_tested',
            verdictState: 'partly_tested',
            paths: ['GET /orders', 'POST /orders'].map((entryPoint, i) => ({
                entryPoint,
                probeId: `reset-lost-${i}`,
                verdict: 'inconclusive',
                base: { transport: 'lost' },
                pr: { transport: 'lost' },
            })),
            uncovered: ['GET /orders', 'POST /orders'].map((entryPoint) => ({ entryPoint, reason: 'inconclusive' })),
        });
        expect(RuntimeRunReportSchema.safeParse(resetLost).success).toBe(true);
        const body = renderReportComment(resetLost, links);
        expect(body).toContain('Booted in 1m 48s · 2 probe outcomes · 0 regressions');
        expect(body).toContain('<details><summary>Probe outcomes (2)</summary>');
        expect(body).toContain('| `GET /orders` | no answer | no answer | Inconclusive |');
        expect(body).toContain('Kody could not establish a reliable comparison for `GET /orders` and `POST /orders`. Check the Run details before trying again.');
        expect(body).not.toMatch(/exercised|What I tested|answered differently|not stable|not deterministic/i);
        const check = renderCheckOutput(resetLost, links);
        expect(check.conclusion).toBe('neutral');
        expect(check.summary).toContain('2 inconclusive');
        expect(check.summary).not.toContain('not stable');
    });

    it.each(['regression', 'halted'] as const)('counts mixed %s results as outcomes, not paths tested', (state) => {
        const mixed = report({
            state,
            paths: [report().paths[0], { entryPoint: 'GET /orders', probeId: 'reset-lost', verdict: 'inconclusive' }],
            securityEvent: state === 'halted',
        });
        const check = renderCheckOutput(mixed, links);
        expect(check.summary).toContain('1 regression reproduced out of 2 probe outcomes.');
        expect(check.summary).not.toContain('paths tested');
    });

    it('does not claim requests were sent when the probe phase only produced outcomes', () => {
        const body = renderProgressComment({ phase: 'reporting', requestedAt: '2026-10-31T14:00:00.000Z', startedAt: '2026-10-31T14:00:00.000Z', tested: { done: 2, total: 2 } }, links);
        expect(body).toContain('- ✓ Evaluated probes · 2 probe outcomes');
        expect(body).not.toContain('Sent requests');
    });

    it('renders findings, what could not be tested, probe outcomes and the footer', () => {
        expect(renderReportComment(report(), links)).toMatchSnapshot();
    });

    it('a regression line says main and PR results and links to the evidence', () => {
        const body = renderReportComment(report(), links);
        expect(body.startsWith('### Kody Runtime · 1 regression\n')).toBe(true);
        expect(body).toContain('Booted in 1m 48s · 2 probe outcomes · 1 regression');
        expect(body).toContain('- Confirmed 1 review suggestion: `POST /orders`.');
        expect(body).toContain(`- **Regression** \`POST /orders\`: 400 on main, 500 on this PR. [Command and output](${RUN_URL})`);
        expect(body).toContain('- `POST /payments`: missing `STRIPE_TEST_KEY`. [Add it](https://app.kodus.test/settings/code-review/repo-1/kody-runtime)');
        expect(body).toContain(`Last run on \`a1b2c3d\` · [Open in Kodus](${RUN_URL}) · [Run again](${RUN_URL}#run-again) · 14 commands · machine destroyed`);
    });

    it('puts the boot error of a PR that does not boot under its regression, in one cut code span', () => {
        const line = `#14 2.31 go: verifying module: github.com/a/b@v1.2.3: Get "https://sum.golang.org/lookup/github.com/a/b@v1.2.3": dial tcp: lookup sum.golang.org: no such host`;
        const body = renderReportComment(
            report({
                paths: [{ entryPoint: 'boot', probeId: 'boot', verdict: 'finding', findingKind: 'pr_destabilizes_machine', intent: 'unintended' }],
                uncovered: [],
                bootError: { side: 'pr', line },
            }),
            links,
        );
        const lines = body.split('\n');
        const at = lines.findIndex((l) => l.startsWith('- **Regression** `boot`: the machine fails on this PR'));
        expect(lines[at + 1]).toMatch(/^ {2}- Boot output on this PR: `#14 2\.31 go: verifying module: .*….*lookup sum\.golang\.org: no such host`$/);
        expect(lines[at + 1].length).toBeLessThan(200);
        expect(body).not.toContain('**Could not test**');
    });

    it('puts the boot error under the not-tested note when the boot did not decide a regression', () => {
        const body = renderReportComment(
            report({
                state: 'partly_tested',
                verdictState: 'partly_tested',
                paths: [],
                uncovered: [{ entryPoint: 'GET /health', reason: 'blocker', blocker: { kind: 'platform' } }],
                bootError: { side: 'pr', line: 'error: `rm -rf` <!-- kody-runtime:comment --> @team [x](http://e.vil)\u202e' },
            }),
            links,
        );
        expect(body).toContain('**Could not test**\n\n- `GET /health`: the platform failed.\n- Boot output on this PR: `error: rm -rf < !-- kody-runtime:comment --> @team [x](http://e.vil)`');
        expect(body.split(RUNTIME_COMMENT_MARKER)).toHaveLength(1);
    });

    it('never says "No regressions" without saying what was tested', () => {
        const body = renderReportComment(
            report({
                state: 'no_regressions',
                verdictState: 'no_regressions',
                paths: [report().paths[1]],
                uncovered: [],
            }),
            links,
        );
        expect(body).toContain('### Kody Runtime · No regressions in what was tested');
        expect(body).toContain('<details><summary>Probe outcomes (1)</summary>');
        expect(body).toContain('| `GET /orders` | 200 | 200 | Same on main and PR |');
        expect(body).not.toContain('**Findings**');
    });

    it('a blocked path names its file, not its coverage id', () => {
        const body = renderReportComment(
            report({
                state: 'partly_tested',
                verdictState: 'partly_tested',
                paths: [],
                uncovered: [{ entryPoint: 'unmapped:pkg/cmd/grafana-cli/commands/reset_password_command.go', reason: 'blocker', blocker: { kind: 'resources' } }],
            }),
            links,
        );
        expect(body).toContain('- `pkg/cmd/grafana-cli/commands/reset_password_command.go`: the machine ran out of resources.');
        expect(body).not.toContain('unmapped:');
    });

    // kr-calcom#2: the PR side built cold for 30 min because the cell had evicted the environment's
    // build state, and the comment said "the machine ran out of resources" with nothing about a setup.
    it('a boot that outlived its wait says so, and one that built cold on an evicted cache says a new setup restores it', () => {
        const timedOut = renderReportComment(
            report({
                state: 'partly_tested',
                verdictState: 'partly_tested',
                paths: [],
                uncovered: [{ entryPoint: 'GET /api/me', reason: 'blocker', blocker: { kind: 'resources', cause: 'boot_timeout' } }],
            }),
            links,
        );
        expect(timedOut).toContain('- `GET /api/me`: the boot did not finish within its wait.');
        expect(timedOut).not.toContain('ran out of resources');

        const cold = report({
            state: 'partly_tested',
            verdictState: 'partly_tested',
            paths: [],
            uncovered: [{ entryPoint: 'GET /api/me', reason: 'blocker', blocker: { kind: 'resources', cause: 'build_state_evicted' } }],
            coldBuild: { side: 'pr', cause: 'build_state_evicted', evictedAt: '2026-11-13T07:31:31.000Z' },
        });
        const body = renderReportComment(cold, links);
        expect(body).not.toContain('ran out of resources');
        expect(body).toContain('because the build cache of this environment was removed to free disk.');
        expect(body).toContain(
            `**Built with no cache**: The build of this PR ran with no cache: the build cache of this environment was removed to free disk (2026-11-13 07:31 UTC); a new setup restores it. [Set it up again](${links.settings}).`,
        );
        expect(renderCheckOutput(cold, links).summary).toContain("this environment's build cache was removed to free disk");
    });

    it('names the changed file a route reaches when Kody mapped the file to that route', () => {
        const body = renderReportComment(
            report({
                state: 'regression',
                verdictState: 'regression',
                paths: [
                    {
                        entryPoint: 'GET /api/health',
                        via: 'pkg/api/health.go',
                        probeId: 'health',
                        verdict: 'finding',
                        findingKind: 'behavior_change',
                        base: { status: 200 },
                        pr: { status: 503 },
                    },
                ],
                uncovered: [],
            }),
            links,
        );
        expect(body).toContain('`GET /api/health` (reaches `pkg/api/health.go`)');
    });

    it("shows what a probe outside the PR's paths sent, with the marker, and keeps it out of coverage", () => {
        const outside = (exercised: string | undefined, verdict: 'not_reproduced' | 'pre_existing') => ({
            entryPoint: 'unmapped',
            probeId: `p-${exercised ?? 'none'}`,
            verdict,
            ...(exercised ? { exercised } : {}),
            base: { status: 200 },
            pr: { status: 200 },
        });
        const body = renderReportComment(
            report({
                state: 'partly_tested',
                verdictState: 'partly_tested',
                paths: [outside('GET /api/health', 'not_reproduced'), outside('POST /a|b`](x)', 'pre_existing'), outside(undefined, 'not_reproduced')],
                uncovered: [{ entryPoint: 'GET /api/dashboards', reason: 'no_probe' }],
            }),
            links,
        );
        expect(body).toContain("| `GET /api/health` (outside this PR's paths) | 200 | 200 | Same on main and PR |");
        expect(body).toContain("| `POST /a\\|b ](x)` (outside this PR's paths) | 200 | 200 | Same on main, not as expected |");
        expect(body).toContain("| A path outside this PR's paths | 200 | 200 | Same on main and PR |");
        expect(body).not.toContain('`unmapped`');
        // The diff's entry point the probes never reached is still listed as not tested.
        expect(body).toContain('GET /api/dashboards');
    });

    it('lists an intended change apart and keeps the check at most neutral', () => {
        const intended = { ...report().paths[0], intent: 'intended' as const, suggestionId: undefined };
        const r = report({ state: 'partly_tested', verdictState: 'partly_tested', paths: [intended], uncovered: [] });
        const body = renderReportComment(r, links);
        expect(body.split('\n')[0]).toBe('### Kody Runtime · Partly tested · 1 intended change');
        expect(body).toContain('- **Intended change** `POST /orders`');
        expect(renderCheckOutput(r, links).conclusion).toBe('neutral');
        expect(body).toContain('A test that already existed on main expects it.');
    });

    it("says an intended change the diff spells out comes from the diff, not from a test", () => {
        const intended = { ...report().paths[0], intent: 'intended' as const, intendedBy: 'diff' as const, suggestionId: undefined };
        const r = RuntimeRunReportSchema.parse(report({ state: 'partly_tested', verdictState: 'partly_tested', paths: [intended], uncovered: [] }));
        const body = renderReportComment(r, links);
        expect(body).toContain("What differs is what this PR's diff changes: main shows what a changed line removes, this PR what it adds.");
        expect(body).not.toContain('A test that already existed on main expects it.');
    });

    it('blocked outbound requests and an untested dependency change force neutral and are listed', () => {
        const r = report({
            state: 'no_regressions',
            verdictState: 'no_regressions',
            paths: [report().paths[1]],
            uncovered: [],
            blockedOutbound: [{ host: 'api.stripe.com', port: 443 }],
            dependencyChangeUntested: true,
        });
        const body = renderReportComment(r, links);
        expect(body.split('\n')[0]).toBe(
            '### Kody Runtime · No regressions in what was tested · 1 blocked outbound request · dependency change not behavior-tested',
        );
        expect(body).toContain('- 1 outbound request blocked by the network policy: `api.stripe.com:443`.');
        expect(renderCheckOutput(r, links).conclusion).toBe('neutral');
    });

    it('lists entry points without a verdict, with the reason, in a collapsed section', () => {
        const body = renderReportComment(report({ uncovered: [{ entryPoint: 'DELETE /orders/:id', reason: 'no_probe' }] }), links);
        expect(body).toContain('<details><summary>Not tested (1)</summary>');
        expect(body).toContain('- `DELETE /orders/:id`: no probe reached it');
    });

    it('a security event is said in the comment, which is never removed', () => {
        const body = renderReportComment(report({ state: 'halted', securityEvent: true }), links);
        expect(body.split('\n')[0]).toBe('### Kody Runtime · 1 regression · security event');
        expect(body).toContain('**Security event**');
    });

    it('a security violation is a failing check with the violation said in words, never the host or the credential', () => {
        const r = report({ state: 'halted', securityViolation: { side: 'pr', signature: 'credential_exfiltration' } });
        const body = renderReportComment(r, links);
        expect(body.split('\n')[0]).toBe('### Kody Runtime · Security violation · 1 regression');
        expect(body).toContain('**Security violation**');
        expect(body).toContain('its test credential');
        expect(checkOf(r).conclusion).toBe('failure');
    });

    it('a secret placeholder refused over plain HTTP is said as the organization secret it stands for, never the host', () => {
        const r = report({ state: 'halted', securityViolation: { side: 'pr', signature: 'placeholder_leak' } });
        const body = renderReportComment(r, links);
        expect(body).toContain("sent one of the organization's secrets (as its placeholder, over plain HTTP) to a host it was not issued for");
        expect(checkOf(r).conclusion).toBe('failure');
    });

    it('says when the Run used the customer cell', () => {
        expect(renderReportComment(report({ cellOwner: 'customer' }), links)).toContain('ran on your own cell');
    });

    it('Runtime text cannot inject markdown, links or mentions', () => {
        const evil = report({
            paths: [
                {
                    ...report().paths[0],
                    entryPoint: 'POST /x`](https://evil.test) @org/admins <img src=x>\n# owned',
                    differingFields: ['body.a`b'],
                    base: { status: 200 },
                    pr: { status: 200 },
                },
            ],
        });
        const body = renderReportComment(evil, links);
        for (const line of body.split('\n').filter((l) => l.includes('evil.test'))) {
            // The only backticks on the line open and close code spans: the URL stays inside one.
            expect(line).toMatch(/`POST \/x \]\(https:\/\/evil\.test\) @org\/admins <img src=x> # owned`/);
        }
        expect(body).not.toMatch(/^# owned/m);
    });
});

describe('browser probe paths (ADR-071)', () => {
    // kr-shop#1: the orders list renders without "keyboard" on the PR, and the screen changed.
    const failingStep: ReportPath = {
        entryPoint: 'GET /',
        via: 'public/app.js',
        probeId: 'orders-page',
        verdict: 'finding',
        findingKind: 'behavior_change',
        intent: 'unintended',
        base: { browser: { passed: 4, total: 4 } },
        pr: { browser: { passed: 3, total: 4 } },
        differingFields: ['steps', 'step.3.value'],
        browserStep: { index: 3, kind: 'expectText', target: '#orders', outcome: 'fails_on_pr' },
        pixelDiffPercent: 1.3,
    };
    const valueDiffers: ReportPath = {
        entryPoint: 'GET /',
        via: 'public/index.html',
        probeId: 'order-button',
        verdict: 'finding',
        findingKind: 'behavior_change',
        intent: 'unintended',
        base: { browser: { passed: 3, total: 3 } },
        pr: { browser: { passed: 3, total: 3 } },
        differingFields: ['step.1.value'],
        browserStep: { index: 1, kind: 'getAttribute', target: '#place', outcome: 'value_differs' },
    };
    const pixelsOnly: ReportPath = {
        entryPoint: 'GET /orders',
        probeId: 'orders-screen',
        base: { browser: { passed: 4, total: 4 } },
        pr: { browser: { passed: 4, total: 4 } },
        verdict: 'inconclusive',
        differingFields: ['pixels.2'],
        pixelDiffPercent: 3,
    };
    const browserReport = (paths: ReportPath[]) => report({ paths, uncovered: [] });

    it('says how many steps passed on each side, which step fails and how much of the screen changed', () => {
        const body = renderReportComment(browserReport([failingStep]), links);
        expect(body).toContain(
            `- **Regression** \`GET /\` (reaches \`public/app.js\`): browser steps 4/4 passed on main, 3/4 on this PR; step 4 \`expectText #orders\` fails on this PR; 1.3% of the screen changed. [Screenshots and video](${RUN_URL})`,
        );
        expect(body).toContain('| `GET /` (reaches `public/app.js`) | 4/4 steps | 3/4 steps | Regression |');
        expect(body).not.toContain('step.3.value');
        expect(body).not.toContain('n/a');
    });

    it('a step that reads differently on both sides names the step, never the value', () => {
        const body = renderReportComment(browserReport([valueDiffers]), links);
        expect(body).toContain(
            `- **Regression** \`GET /\` (reaches \`public/index.html\`): browser steps 3/3 passed on main, 3/3 on this PR; step 2 \`getAttribute #place\` differs. [Screenshots and video](${RUN_URL})`,
        );
        expect(body).toContain('| `GET /` (reaches `public/index.html`) | 3/3 steps | 3/3 steps | Regression |');
    });

    it('a pixel-only difference is a visual question with evidence and a neutral check', () => {
        const result = report({ state: 'partly_tested', verdictState: 'partly_tested', paths: [pixelsOnly], uncovered: [] });
        const body = renderReportComment(result, links);
        expect(body).toContain(
            `- **Visual change** \`GET /orders\`: browser steps 4/4 passed on main, 4/4 on this PR; 3% of the screen changed. [Screenshots and video](${RUN_URL})`,
        );
        expect(body).toContain('Is this appearance change intended?');
        expect(body).toContain('| `GET /orders` | 4/4 steps | 4/4 steps | Visual change |');
        expect(body).not.toContain('**Regression**');
        expect(checkOf(result)).toMatchObject({ conclusion: 'neutral' });
        expect(body).not.toContain('pixels.2');
    });

    it('a field the browser wording does not cover is still named, in the reader\'s terms', () => {
        const body = renderReportComment(browserReport([{ ...failingStep, differingFields: ['steps', 'step.3.value', 'step.5.value', 'console'] }]), links);
        expect(body).toContain('1.3% of the screen changed, also differs in step 6 value, `console`.');
    });

    it.each([
        { differingFields: ['pixels.2', 'network.0.status'] },
        { differingFields: [] },
        { base: { transport: 'lost' as const } },
        { browserStep: failingStep.browserStep },
    ])('does not invent a visual question for other inconclusive evidence: %j', (patch) => {
        const body = renderReportComment(browserReport([{ ...pixelsOnly, ...patch }]), links);
        expect(body).not.toContain('Is this appearance change intended?');
        expect(body).not.toContain('**Visual change**');
    });

    it('a step that fails on main, or on both sides differently, says so', () => {
        const onMain = renderReportComment(browserReport([{ ...failingStep, base: { browser: { passed: 3, total: 4 } }, pr: { browser: { passed: 4, total: 4 } }, browserStep: { index: 3, kind: 'expectText', target: '#orders', outcome: 'fails_on_main' } }]), links);
        expect(onMain).toContain('step 4 `expectText #orders` fails on main');
        const both = renderReportComment(browserReport([{ ...failingStep, base: { browser: { passed: 3, total: 4 } }, browserStep: { index: 3, kind: 'click', outcome: 'fails_differently' } }]), links);
        expect(both).toContain('browser steps 3/4 passed on main, 3/4 on this PR; step 4 `click` fails differently on main and on this PR');
    });

    it('a side with no answer keeps the generic wording, with the browser link', () => {
        const body = renderReportComment(browserReport([{ ...failingStep, pr: { transport: 'lost' }, browserStep: undefined, pixelDiffPercent: undefined }]), links);
        expect(body).toContain(`\`GET /\` (reaches \`public/app.js\`): 4/4 steps on main, no answer on this PR, differs in step outcomes, step 4 value. [Screenshots and video](${RUN_URL})`);
    });

    it('a report from before the browser fields renders as it did', () => {
        const old: ReportPath = { ...failingStep, base: undefined, pr: undefined, browserStep: undefined, pixelDiffPercent: undefined };
        delete old.base;
        delete old.pr;
        delete old.browserStep;
        delete old.pixelDiffPercent;
        const body = renderReportComment(browserReport([old]), links);
        expect(body).toContain(
            `- **Regression** \`GET /\` (reaches \`public/app.js\`): n/a on main, n/a on this PR, differs in \`steps\`, \`step.3.value\`. [Command and output](${RUN_URL})`,
        );
        expect(body).toContain('| `GET /` (reaches `public/app.js`) | n/a | n/a | Regression |');
    });

    it('a selector stays inside one code span', () => {
        const body = renderReportComment(browserReport([{ ...failingStep, browserStep: { index: 0, kind: 'click', target: 'a`[x](https://evil.test) @here\nb', outcome: 'fails_on_pr' } }]), links);
        const line = body.split('\n').find((l) => l.includes('evil.test'))!;
        expect(line).toContain('step 1 `click a [x](https://evil.test) @here b` fails on this PR');
    });

    it('the confirmed suggestion reply names the steps and links to the screenshots', () => {
        expect(renderSuggestionReply(failingStep, links)).toBe(
            `**Ran it: confirmed.** I sent \`GET /\` (reaches \`public/app.js\`) to main and to this pull request: 4/4 steps on main, 3/4 steps here. [Screenshots and video](${RUN_URL})`,
        );
    });

    it('renders the kr-shop comment', () => {
        expect(renderReportComment(browserReport([failingStep, valueDiffers]), links)).toMatchSnapshot();
    });

    it('the report contract keeps the browser fields bounded', () => {
        const ok = browserReport([failingStep, valueDiffers, pixelsOnly]);
        expect(RuntimeRunReportSchema.safeParse(ok).success).toBe(true);
        const bad = (patch: Partial<ReportPath>) => RuntimeRunReportSchema.safeParse(browserReport([{ ...failingStep, ...patch }])).success;
        expect(bad({ pixelDiffPercent: 101 })).toBe(false);
        expect(bad({ pr: { browser: { passed: 5, total: 4 } } })).toBe(false);
        expect(bad({ pr: { browser: { passed: 0, total: 0 } } })).toBe(false);
        expect(bad({ browserStep: { index: 3, kind: 'expectText', target: 'x'.repeat(129), outcome: 'fails_on_pr' } })).toBe(false);
        expect(bad({ browserStep: { index: 100, kind: 'expectText', outcome: 'fails_on_pr' } })).toBe(false);
        expect(bad({ browserStep: { index: 3, kind: 'evaluate' as any, outcome: 'fails_on_pr' } })).toBe(false);
        expect(bad({ browserStep: { index: 3, kind: 'click', outcome: 'flaky' as any } })).toBe(false);
        expect(bad({ browserStep: { index: 3, kind: 'click', outcome: 'fails_on_pr', value: 'keyboard' } as any })).toBe(false);
    });
});

describe('renderSuggestionReply (screen 7)', () => {
    it('confirms the review suggestion with what each side answered', () => {
        expect(renderSuggestionReply(report().paths[0], links)).toBe(
            `**Ran it: confirmed.** I sent \`POST /orders\` to main and to this pull request: 400 on main, 500 here. [Command and output](${RUN_URL})`,
        );
    });
});

describe('renderCheckOutput (screen 9: the check is never mute)', () => {
    const cases: Array<[string, Partial<RuntimeRunReport>, string, string, string]> = [
        [
            'no regressions',
            { state: 'no_regressions', verdictState: 'no_regressions', paths: [report().paths[1]], uncovered: [] },
            'success',
            'No regressions in what was tested',
            '1 probe outcome, same result on main and on this PR.',
        ],
        ['regression', {}, 'failure', '1 regression', '1 regression reproduced out of 2 probe outcomes.'],
        [
            'partly tested by a missing key',
            { state: 'partly_tested', verdictState: 'partly_tested', paths: [report().paths[1]] },
            'neutral',
            'Partly tested',
            '1 path skipped: missing `STRIPE_TEST_KEY`. [Add it](https://app.kodus.test/settings/code-review/repo-1/kody-runtime)',
        ],
        [
            'could not boot: outdated recipe is not a bug',
            { state: 'could_not_boot', verdictState: 'could_not_boot', paths: [], uncovered: [], bootFailure: { failsOnBase: true, kind: 'recipe_outdated' } },
            'neutral',
            'Could not boot',
            'Fails on main too: the recipe is outdated. This is not a bug in the pull request. The review is not affected.',
        ],
        [
            'skipped on request only',
            { state: 'skipped', verdictState: undefined, paths: [], uncovered: [], skipReason: 'on_request_only' },
            'skipped',
            'Skipped',
            'On request only. Comment `@kody runtime` to run.',
        ],
        [
            'skipped without an environment',
            { state: 'skipped', verdictState: undefined, paths: [], uncovered: [], skipReason: 'no_environment' },
            'skipped',
            'Skipped',
            'No environment for this repository. [Set it up](https://app.kodus.test/settings/code-review/repo-1/kody-runtime)',
        ],
        [
            'errored',
            { state: 'errored', verdictState: undefined, paths: [], uncovered: [] },
            'neutral',
            'Could not finish',
            `Kody could not finish this Run. The review is not affected. [Run again](${RUN_URL}#run-again)`,
        ],
        [
            'timed out',
            { state: 'timed_out', verdictState: undefined, paths: [], uncovered: [] },
            'timed_out',
            'Timed out',
            `The Run took longer than the limit and was stopped. [Run again](${RUN_URL}#run-again)`,
        ],
        [
            'fork waiting for a maintainer',
            { state: 'awaiting_approval', verdictState: undefined, paths: [], uncovered: [] },
            'action_required',
            'Waiting for a maintainer',
            // No approval path exists yet: promise no command that does nothing.
            'This pull request comes from a fork. A fork Run needs a maintainer approval, which Kodus cannot take yet, so it does not start.',
        ],
    ];

    it.each(cases)('%s', (_name, patch, conclusion, title, line) => {
        const out = renderCheckOutput(report(patch), links);
        expect(out.conclusion).toBe(conclusion);
        expect(out.title).toBe(title);
        expect(out.summary).toBe(`${line} · [View run](${RUN_URL})`);
    });

    it('the summary carries counts and structured labels, never an entry point', () => {
        expect(renderCheckOutput(report(), links).summary).not.toContain('/orders');
    });
});

describe('routes the PR adds (kr-shop#4)', () => {
    // POST /orders/preview does not exist on main: two probes, 404 on main, 200 and 400 on the PR.
    const preview = (probeId: string, prStatus: number, over: Partial<ReportPath> = {}): ReportPath => ({
        entryPoint: 'POST /orders/preview',
        probeId,
        verdict: 'new_endpoint',
        base: { status: 404 },
        pr: { status: prStatus },
        differingFields: ['status', 'json'],
        ...over,
    });
    const listOrders = report().paths[1];
    const kr4 = report({ state: 'no_regressions', verdictState: 'no_regressions', paths: [preview('preview-total', 200), preview('preview-empty', 400), listOrders], uncovered: [] });

    it('a route the PR adds is reported as a new endpoint, not a regression', () => {
        expect(RuntimeRunReportSchema.parse(kr4)).toBeTruthy();
        const check = renderCheckOutput(kr4, links);
        expect(check).toMatchObject({ conclusion: 'success', title: 'No regressions in what was tested · 2 new endpoints' });
        expect(check.summary).toBe(`3 probe outcomes, no regression. 2 new endpoints this PR adds answered on the PR. · [View run](${RUN_URL})`);
        const body = renderReportComment(kr4, links);
        expect(body).not.toContain('**Regression**');
        expect(body).not.toContain('**Findings**');
        expect(body).toContain('**New endpoints**');
        expect(body).toContain('- **New endpoint** `POST /orders/preview` · `preview-total`: no such route on main (404), 200 on this PR.');
        expect(body).toContain('- **New endpoint** `POST /orders/preview` · `preview-empty`: no such route on main (404), 400 on this PR.');
        expect(body).toContain('| `POST /orders/preview` · `preview-total` | 404 | 200 | New endpoint |');
        expect(body).toContain('3 probe outcomes · 0 regressions · 2 new endpoints');
    });

    it('a new route that errors in the PR is reported as a finding on the new code', () => {
        const failing = report({
            state: 'regression',
            verdictState: 'regression',
            paths: [preview('preview-total', 502, { verdict: 'finding', findingKind: 'new_endpoint_error', intent: 'unintended' }), preview('preview-empty', 400), listOrders],
            uncovered: [],
        });
        const check = renderCheckOutput(failing, links);
        expect(check).toMatchObject({ conclusion: 'failure', title: '1 error on a new endpoint · 1 new endpoint' });
        expect(check.summary).toContain('1 error on a new endpoint reproduced out of 3 probe outcomes.');
        const body = renderReportComment(failing, links);
        expect(body).not.toContain('**Regression**');
        expect(body).toContain('- **Error on a new endpoint** `POST /orders/preview` · `preview-total`: no such route on main (404), 502 on this PR.');
        expect(body).toContain('| `POST /orders/preview` · `preview-total` | 404 | 502 | Error on a new endpoint |');
    });

    it('a route the PR removes still fails as a regression', () => {
        const removed = report({
            paths: [preview('preview', 404, { verdict: 'finding', findingKind: 'behavior_change', intent: 'unintended', base: { status: 200 } })],
            uncovered: [],
        });
        expect(renderCheckOutput(removed, links)).toMatchObject({ conclusion: 'failure', title: '1 regression' });
        expect(renderReportComment(removed, links)).toContain('- **Regression** `POST /orders/preview`: 200 on main, 404 on this PR.');
    });
});

describe('a member the recipe does not boot (kr-shop-billing, 2026-11-13)', () => {
    const notBooted = report({
        state: 'partly_tested',
        verdictState: 'partly_tested',
        paths: [],
        uncovered: [{ entryPoint: 'POST /invoices/preview', reason: 'blocker', blocker: { kind: 'other_repo', alias: 'billing' } }],
    });

    it('says the recipe does not boot the member and how to boot it, never "the same failure on both versions"', () => {
        expect(RuntimeRunReportSchema.parse(notBooted)).toBeTruthy();
        const body = renderReportComment(notBooted, links);
        expect(body).toContain('the recipe does not boot `billing`. Add `billing` to `services.needs` in `.kodus/workspace.yaml` on the default branch.');
        expect(body).not.toContain('same failure was observed on both versions');
        const check = renderCheckOutput(notBooted, links);
        expect(check.summary.startsWith('1 path not tested: the recipe does not boot `billing`.')).toBe(true);
    });
});

describe('renderBareCheckOutput (a check without a report)', () => {
    it('words the phase from the product table, with a link to the Run only', () => {
        expect(renderBareCheckOutput({ status: 'in_progress' }, links)).toEqual({
            title: 'Running',
            summary: `Kody is testing this pull request. · [View run](${links.run})`,
        });
        expect(renderBareCheckOutput({ status: 'completed', conclusion: 'action_required' }, {}).title).toBe('Waiting for a maintainer');
        expect(renderBareCheckOutput({ status: 'completed', conclusion: 'action_required' }, {}).summary).not.toContain('@kody');
    });
});

describe('comment marker', () => {
    it('is added once, at the end', () => {
        const once = withCommentMarker('body');
        expect(once).toBe(`body\n\n${RUNTIME_COMMENT_MARKER}`);
        expect(withCommentMarker(once)).toBe(once);
        expect(hasCommentMarker(once)).toBe(true);
        expect(hasCommentMarker(undefined)).toBe(false);
    });
});

describe('recipe changed in the PR (S-19)', () => {
    const changed = report({ recipeChangedInPr: ['.kodus/workspace.yaml'] });

    it('the comment says the base recipe ran, naming only the fixed path', () => {
        const body = renderReportComment(changed, links);
        expect(body).toContain('**Recipe changed**: This pull request changes the Runtime recipe (`.kodus/workspace.yaml`).');
        expect(body).toContain('recipe from the base branch, so the new recipe was not tested');
        expect(renderReportComment(report(), links)).not.toContain('Recipe changed');
    });

    it('the check summary says it too, in every state', () => {
        for (const state of ['regression', 'no_regressions', 'could_not_boot', 'skipped'] as const) {
            const { summary } = renderCheckOutput(report({ ...changed, state, verdictState: state === 'skipped' ? undefined : (state as any) }), links);
            expect(summary).toContain('changes the Runtime recipe (`.kodus/workspace.yaml`)');
        }
        expect(renderCheckOutput(report(), links).summary).not.toContain('recipe');
    });

    it('a PR that changes only the recipe (nothing booted) reads as nothing to call, plus the recipe note', () => {
        const body = renderReportComment(report({ state: 'partly_tested', verdictState: 'partly_tested', paths: [], uncovered: [], recipeChangedInPr: ['.kodus/workspace.yaml'] }), links);
        expect(body).toContain('This pull request changes nothing Kody can call (no route, job or command), so there was nothing to test.');
        expect(body).toContain('Kody boots every pull request with the recipe from the base branch, so the new recipe was not tested.');
        // Nothing booted: the note never says the Run ran it.
        expect(body).not.toMatch(/Kody ran it|The Run used/);
    });

    it('names both files when the PR changes both', () => {
        const body = renderReportComment(report({ recipeChangedInPr: ['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml'] }), links);
        expect(body).toContain('(`.kodus/workspace.runtime.yaml`, `.kodus/workspace.yaml`)');
    });
});

describe('why a Run is partly tested', () => {
    // kr-grafana#3: the PR only changed a comment line in a Go file no extractor maps.
    const commentOnlyGoChange = report({
        state: 'partly_tested',
        verdictState: 'partly_tested',
        paths: [{ entryPoint: 'GET /api/health', probeId: 'health', verdict: 'pre_existing', base: { status: 200 }, pr: { status: 200 } }],
        uncovered: [{ entryPoint: 'unmapped:pkg/cmd/grafana/main.go', reason: 'no_probe' }],
    });

    it('says in plain words why a changed file was not tested and what to do', () => {
        const body = renderReportComment(commentOnlyGoChange, links);
        expect(body).toContain(
            [
                '**Why partly tested**',
                '',
                '- Kody could not map `pkg/cmd/grafana/main.go` to a route, job or command it can call, so no probe reached it. Nothing to do if it changes no behavior (a comment, a log line, a rename); otherwise check it by hand.',
            ].join('\n'),
        );
    });

    it('the not-tested list names the file, without the extractor prefix', () => {
        expect(renderReportComment(commentOnlyGoChange, links)).toContain('- `pkg/cmd/grafana/main.go`: no probe reached it');
    });

    it('the check summary gives the cause as counts, never a file', () => {
        const out = renderCheckOutput(commentOnlyGoChange, links);
        expect(out.title).toBe('Partly tested');
        expect(out.summary).toBe(
            `1 path without a verdict out of 2: 1 file Kody cannot map to a route, job or command. · [View run](${RUN_URL})`,
        );
        expect(out.summary).not.toContain('main.go');
    });

    it('groups each cause once, lists at most three entry points, and offers what can be done', () => {
        const reasons = partlyTestedReasons(
            report({
                state: 'partly_tested',
                uncovered: [
                    { entryPoint: 'GET /a', reason: 'no_probe' },
                    { entryPoint: 'GET /b', reason: 'no_probe' },
                    { entryPoint: 'GET /c', reason: 'no_probe' },
                    { entryPoint: 'GET /d', reason: 'no_probe' },
                    { entryPoint: 'POST /flaky', reason: 'inconclusive' },
                    { entryPoint: 'job:jobs/sync.ts', reason: 'not_reached' },
                    { entryPoint: 'unmapped:diff-truncated', reason: 'no_probe' },
                    { entryPoint: 'POST /payments', reason: 'blocker', blocker: { kind: 'missing_env', name: 'STRIPE_TEST_KEY' } },
                ],
            }),
            links,
        );
        expect(reasons).toEqual([
            'The diff was too large to test whole, so part of it was not tested. Split the pull request to test all of it.',
            'No request Kody sent reached `GET /a`, `GET /b`, `GET /c` and 1 more in the running app, so their behavior on this pull request is unknown. They may need data, a login or a flag the environment does not have.',
            'Kody could not establish a reliable comparison for `POST /flaky`. Check the Run details before trying again.',
            `The Run stopped before it tested \`jobs/sync.ts\`. [Run again](${RUN_URL}#run-again) to test it.`,
        ]);
    });

    it('a pull request with nothing to call says so', () => {
        expect(partlyTestedReasons(report({ state: 'partly_tested', paths: [], uncovered: [] }), links)).toEqual([
            'This pull request changes nothing Kody can call (no route, job or command), so there was nothing to test.',
        ]);
    });

    it('explains nothing for other states', () => {
        expect(partlyTestedReasons(report(), links)).toEqual([]);
        expect(renderReportComment(report(), links)).not.toContain('Why partly tested');
    });

    it('Runtime text in the explanation stays inside one code span', () => {
        const body = renderReportComment(
            report({
                state: 'partly_tested',
                uncovered: [{ entryPoint: 'unmapped:a`](https://evil.test) <img src=x> @everyone\n<script>x</script>', reason: 'no_probe' }],
            }),
            links,
        );
        const line = body.split('\n').find((l) => l.includes('evil.test'))!;
        expect(line).toContain('`a ](https://evil.test) <img src=x> @everyone <script>x</script>`');
        expect(line.split('`')).toHaveLength(3);
        expect(body).not.toMatch(/^<script>/m);
    });
});

describe('renderUndeliveredReportComment (the report could not be posted)', () => {
    it('replaces the progress with the verdict and a link to the Run, nothing from the report', () => {
        expect(renderUndeliveredReportComment(report(), links)).toBe(
            [
                '### Kody Runtime · 1 regression',
                '',
                `Kody finished this Run but could not post the full report here. [Open in Kodus](${RUN_URL})`,
                '',
                '---',
                'Last run on `a1b2c3d`',
            ].join('\n'),
        );
    });

    it('without a dashboard URL, says where to look', () => {
        const body = renderUndeliveredReportComment(report(), {});
        expect(body).toContain('It is on the Run page in Kodus.');
        expect(body).not.toContain('](');
    });
});

describe('the preview line (docs/runtime/preview-urls.md §8.1)', () => {
    const withPreview = (prOff?: string) => ({ ...links, preview: previewLinks('https://app.kodus.test', RUN, { idleMinutes: 15, ...(prOff ? { prOff } : {}) }) });

    it('offers both sides on the dashboard, never a preview host, with who may open it and when it stops', () => {
        const body = renderReportComment(report(), withPreview());
        const line = body.split('\n').find((l) => l.startsWith('**Preview**'))!;
        expect(line).toContain(`[Open the PR version](${RUN_URL}/preview?side=pr)`);
        expect(line).toContain(`[Open the base version](${RUN_URL}/preview?side=base)`);
        expect(line).toContain('stops after 15 idle minutes');
        expect(line).toContain('members of the organization');
        expect(renderCheckOutput(report(), withPreview()).summary).toContain(`[Preview the PR version](${RUN_URL}/preview?side=pr)`);
    });

    it("says why a fork's PR version does not open, and still offers the base", () => {
        const line = renderReportComment(report(), withPreview('Preview is off for pull requests from forks.')).split('\n').find((l) => l.startsWith('**Preview**'))!;
        expect(line).not.toContain('side=pr');
        expect(line).toContain('Preview is off for pull requests from forks.');
        expect(line).toContain('side=base');
    });

    it('is absent when previews are off, for a Run that tested nothing or halted, and for a multi-repository Run', () => {
        expect(renderReportComment(report(), links)).not.toContain('**Preview**');
        for (const state of ['halted', 'could_not_boot', 'skipped', 'errored'] as const) {
            expect(renderReportComment(report({ state }), withPreview())).not.toContain('**Preview**');
            expect(renderCheckOutput(report({ state }), withPreview()).summary).not.toContain('Preview the');
        }
        const workspace = [{ alias: 'api', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), source: 'pull_request' as const }];
        expect(renderReportComment(report(), withPreview(), { workspace } as never)).not.toContain('**Preview**');
    });
});

describe('nothing to test at runtime (planner-eval.md fix 1)', () => {
    const nothing = report({
        state: 'nothing_to_test',
        verdictState: 'nothing_to_test',
        bootMs: undefined,
        paths: [],
        uncovered: [],
        noRuntimeEffect: ['server/src/controllers/server.controller.ts'],
    });

    it('the report is valid, and the comment says the PR does not change what runs and which files were read so', () => {
        expect(RuntimeRunReportSchema.safeParse(nothing).success).toBe(true);
        const body = renderReportComment(nothing, links);
        expect(body).toContain('### Kody Runtime · Nothing to test at runtime');
        expect(body).toContain('does not change what the app does at runtime');
        expect(body).toContain(code('server/src/controllers/server.controller.ts'));
        expect(body).not.toContain('Why partly tested');
    });

    it('the check is neutral, never green and never partly tested', () => {
        expect(checkOf(nothing)).toEqual({ conclusion: 'neutral', title: 'Nothing to test at runtime' });
        expect(renderCheckOutput(nothing, links).summary).toContain('does not change what the app does at runtime');
    });
});

// kr-kodus-ai#1: two probes of POST /auth/signUp (an invalid email, a password
// with no symbol) showed as two identical rows; the developer could not tell
// which case answered what.
describe('two probes of one route', () => {
    it('name their case in the outcomes table; a route probed once stays as it was', () => {
        const signUp = (probeId: string, pr: number) => ({
            entryPoint: 'POST /auth/signUp',
            via: 'libs/identity/dtos/create-user-organization.dto.ts',
            probeId,
            verdict: 'inconclusive' as const,
            base: { status: 400 },
            pr: { status: pr },
        });
        const body = renderReportComment(
            report({ state: 'partly_tested', verdictState: 'partly_tested', paths: [signUp('signup-invalid-email', 201), signUp('signup-password-no-symbol', 201), { entryPoint: 'GET /health', probeId: 'health', verdict: 'not_reproduced', base: { status: 200 }, pr: { status: 200 } }], uncovered: [] }),
            links,
        );
        expect(body).toContain('· `signup-invalid-email` |');
        expect(body).toContain('· `signup-password-no-symbol` |');
        expect(body).toContain('| `GET /health` | 200 | 200 |');
    });

    // A Run: both findings read "Regression `POST /auth/signUp` …: 400 on main, 201 on this PR".
    it('name their case in the findings too', () => {
        const signUp = (probeId: string) => ({ entryPoint: 'POST /auth/signUp', probeId, verdict: 'finding' as const, findingKind: 'behavior_change' as const, intent: 'unintended' as const, base: { status: 400 }, pr: { status: 201 } });
        const body = renderReportComment(report({ paths: [signUp('signup-invalid-email'), signUp('signup-password-no-symbol')], uncovered: [] }), links);
        expect(body).toContain('- **Regression** `POST /auth/signUp` · `signup-invalid-email`: 400 on main, 201 on this PR.');
        expect(body).toContain('- **Regression** `POST /auth/signUp` · `signup-password-no-symbol`: 400 on main, 201 on this PR.');
    });
});


describe('changed lines exercised', () => {
    const green = { state: 'no_regressions' as const, verdictState: 'no_regressions' as const, paths: [report().paths[1]], uncovered: [] };
    const files = [{ path: 'src/orders.ts', changedLines: 10, exercisedLines: 4, status: 'measured' as const }];

    it('says how many changed lines ran, and a Run partly tested by it says why in the comment and the check', () => {
        const r = report({ ...green, state: 'partly_tested', verdictState: 'partly_tested', exercised: { summary: { exercised: 4, changed: 10, threshold: 0.5, language: 'node', measured: true }, files } });
        expect(RuntimeRunReportSchema.safeParse(r).success).toBe(true);
        const body = renderReportComment(r, {});
        expect(body).toContain('Changed lines exercised: 4 of 10');
        expect(body).toContain('- Only 4 of 10 changed lines ran during the probes, under the 50% this Run needs.');
        expect(renderCheckOutput(r, {}).summary).toContain('4 of 10 changed lines ran');
    });

    it('says the lines were not measured when the cell gave no answer', () => {
        const body = renderReportComment(report({ ...green, exercised: { summary: { exercised: 0, changed: 0, threshold: 0.5, measured: false }, files: [] } }), {});
        expect(body).toContain('Changed lines exercised: not measured');
    });

    it('has no exercised line on a Run without the field', () => {
        expect(renderReportComment(report(green), {})).not.toContain('Changed lines exercised');
    });
});
