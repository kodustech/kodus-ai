#!/usr/bin/env node
// Which shapes of the product a pull request needs a preview of.
//
// Kodus ships the same code in two shapes — cloud (billing, analytics) and
// self-hosted — and a preview VM is a t3.xlarge with a fleet cap of three, so
// "every PR gets both" would cost more than it tells us. This decides per PR:
//
//   1. labels win when present: preview:cloud, preview:self-hosted (any
//      combination), or preview:none alone. A human, or Kody, sets them.
//   2. otherwise, rules over the changed files:
//        - nothing but docs/tests/CI touched            → none
//        - a change that reads the deployment mode      → both
//          (patch mentions isSelfHosted/selfHosted/API_CLOUD_MODE/WEB_NODE_ENV,
//           or lives in a self-hosted-only or cloud-only file)
//        - self-hosted-only files touched, nothing else  → self-hosted
//        - anything else in the product                 → cloud (what
//          kodus.io runs; the default shape of a preview)
//
// Pure: input on stdin ({ labels: string[], files: [{ filename, patch? }] }),
// decision on stdout ({ profiles: string[], reason: string, source }). The
// preview workflow feeds it the pull request via the GitHub API; run it with
// --self-test to check the rules.
'use strict';

const PROFILES = ['cloud', 'self-hosted'];

// Files whose change never needs a running product.
const IGNORED = [
    /^docs\//,
    /^docs-internal\//,
    /\.md$/,
    /^\.github\//,
    /^\.kody\//,
    /(^|\/)__tests__\//,
    /\.(test|spec)\.[cm]?[jt]sx?$/,
    /^tests?\//,
    /^evals\//,
    /^scripts\/benchmark\//,
];

// Files that exist for one shape only. Touching them is a signal for that
// shape; touching both kinds means both.
const SELF_HOSTED_ONLY = [
    /^docker-compose\.preview\.selfhosted\.yml$/,
    /^\.kodus\/workspace\.preview\.selfhosted\.yaml$/,
    /(^|\/)self-hosted(\/|\.|-)/i,
    /selfhosted/i,
    /^libs\/ee\/license\//,
];
const CLOUD_ONLY = [
    /^docker-compose\.preview\.cloud\.yml$/,
    /^\.kodus\/workspace\.preview\.yaml$/,
    /(^|\/)billing(\/|\.|-)/i,
    /(^|\/)stripe(\/|\.|-)/i,
];

// A patch that reads the mode is a change whose behavior differs per shape.
const MODE_GATE = /\b(isSelfHosted|selfHosted|API_CLOUD_MODE|WEB_NODE_ENV|isCloud(Mode)?|cloudMode)\b/;

function decide({ labels = [], files = [] }) {
    const wanted = new Set(labels.filter((l) => l.startsWith('preview:')).map((l) => l.slice('preview:'.length)));
    if (wanted.size) {
        const profiles = PROFILES.filter((p) => wanted.has(p));
        if (profiles.length) return { profiles, reason: `labels: ${profiles.map((p) => `preview:${p}`).join(', ')}`, source: 'labels' };
        if (wanted.has('none')) return { profiles: [], reason: 'label: preview:none', source: 'labels' };
        // an unknown preview:* label is a typo, not a decision
    }

    const relevant = files.filter((f) => !IGNORED.some((re) => re.test(f.filename)));
    if (relevant.length === 0)
        return { profiles: [], reason: files.length ? 'only docs, tests or CI changed' : 'no files changed', source: 'rules' };

    const modeGated = relevant.filter((f) => MODE_GATE.test(f.patch ?? ''));
    const selfHostedOnly = relevant.filter((f) => SELF_HOSTED_ONLY.some((re) => re.test(f.filename)));
    const cloudOnly = relevant.filter((f) => CLOUD_ONLY.some((re) => re.test(f.filename)));
    const other = relevant.filter((f) => !selfHostedOnly.includes(f) && !cloudOnly.includes(f));
    const name = (list) => list.slice(0, 3).map((f) => f.filename).join(', ') + (list.length > 3 ? ` (+${list.length - 3})` : '');

    if (modeGated.length)
        return { profiles: [...PROFILES], reason: `reads the deployment mode: ${name(modeGated)}`, source: 'rules' };
    if (selfHostedOnly.length && cloudOnly.length)
        return { profiles: [...PROFILES], reason: `touches both shapes: ${name(selfHostedOnly)} and ${name(cloudOnly)}`, source: 'rules' };
    if (selfHostedOnly.length && other.length === 0)
        return { profiles: ['self-hosted'], reason: `self-hosted-only files: ${name(selfHostedOnly)}`, source: 'rules' };
    if (selfHostedOnly.length)
        return { profiles: [...PROFILES], reason: `self-hosted files plus product code: ${name(selfHostedOnly)}`, source: 'rules' };
    return { profiles: ['cloud'], reason: cloudOnly.length ? `cloud-only files: ${name(cloudOnly)}` : `product code changed: ${name(other)}`, source: 'rules' };
}

function selfTest() {
    const assert = require('node:assert/strict');
    const f = (filename, patch = '') => ({ filename, patch });
    const cases = [
        [{ files: [] }, []],
        [{ files: [f('README.md'), f('docs/x.md'), f('.github/workflows/tests.yml'), f('libs/a/b.spec.ts')] }, []],
        [{ files: [f('libs/code-review/review.ts', '+const x = 1')] }, ['cloud']],
        [{ files: [f('apps/api/src/auth/auth.controller.ts', '+if (isSelfHosted) {')] }, ['cloud', 'self-hosted']],
        [{ files: [f('apps/web/src/app/settings/page.tsx', '+process.env.WEB_NODE_ENV')] }, ['cloud', 'self-hosted']],
        [{ files: [f('docker-compose.preview.selfhosted.yml')] }, ['self-hosted']],
        [{ files: [f('libs/ee/license/license.service.ts')] }, ['self-hosted']],
        [{ files: [f('libs/ee/license/license.service.ts'), f('libs/code-review/review.ts')] }, ['cloud', 'self-hosted']],
        [{ files: [f('libs/billing/plan.ts')] }, ['cloud']],
        [{ files: [f('libs/billing/plan.ts'), f('docker-compose.preview.selfhosted.yml')] }, ['cloud', 'self-hosted']],
        [{ labels: ['preview:none'], files: [f('libs/code-review/review.ts')] }, []],
        [{ labels: ['preview:self-hosted'], files: [f('libs/billing/plan.ts')] }, ['self-hosted']],
        [{ labels: ['preview:cloud', 'preview:self-hosted'], files: [] }, ['cloud', 'self-hosted']],
        [{ labels: ['preview:none', 'preview:cloud'], files: [] }, ['cloud']],
        [{ labels: ['preview:staging'], files: [f('libs/code-review/review.ts')] }, ['cloud']],
    ];
    for (const [input, expected] of cases) {
        const got = decide(input);
        assert.deepEqual(got.profiles, expected, `${JSON.stringify(input)} → ${JSON.stringify(got)}`);
    }
    console.log(`decide-profiles: ${cases.length} cases ok`);
}

module.exports = { decide, PROFILES };

if (require.main === module) {
    if (process.argv.includes('--self-test')) selfTest();
    else {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (raw += c));
        process.stdin.on('end', () => process.stdout.write(JSON.stringify(decide(JSON.parse(raw || '{}'))) + '\n'));
    }
}
