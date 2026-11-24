import { XMLParser } from 'fast-xml-parser';

import { errorSignature } from './error-signature';
import { type SpecResult, specResultOf, type TestAttempt, type TestResult } from './types';

// JUnit XML as Cypress (mocha-junit-reporter) and Playwright write it. The
// engine parses it on the host and stores JSON, never the XML (section 7).

const ARRAYS = new Set(['testsuite', 'testcase', 'failure', 'error', 'skipped', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);
const MAX_ERROR_CHARS = 4000;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    isArray: (name) => ARRAYS.has(name),
});

type Node = Record<string, unknown>;
const asNodes = (v: unknown): Node[] => (Array.isArray(v) ? v.filter((x): x is Node => !!x && typeof x === 'object') : []);
const attr = (n: Node, name: string): string | undefined => (typeof n[`@_${name}`] === 'string' ? (n[`@_${name}`] as string) : undefined);
const ms = (n: Node): number => {
    const t = Number(attr(n, 'time'));
    return Number.isFinite(t) && t > 0 ? Math.round(t * 1000) : 0;
};

/** The failure element's error: its message, else its text. Elements may be strings, empty or nodes. */
function errorOf(el: unknown): string {
    if (typeof el === 'string') return el.slice(0, MAX_ERROR_CHARS);
    if (!el || typeof el !== 'object') return '';
    const n = el as Node;
    const message = attr(n, 'message');
    const text = typeof n['#text'] === 'string' ? (n['#text'] as string).trim() : '';
    return (message || text).slice(0, MAX_ERROR_CHARS);
}

function attemptsOf(c: Node): { attempts: TestAttempt[]; status: TestResult['status'] } {
    const failed = (key: string) => (Array.isArray(c[key]) ? (c[key] as unknown[]) : []);
    const time = ms(c);
    const failures = [...failed('failure'), ...failed('error')];
    const reruns = [...failed('rerunFailure'), ...failed('rerunError')];
    const flaky = [...failed('flakyFailure'), ...failed('flakyError')];
    if (failures.length > 0) {
        const attempts: TestAttempt[] = [...failures, ...reruns].map((e) => ({ status: 'failed', ms: time, error: errorOf(e) }));
        return { attempts, status: 'failed' };
    }
    if (Array.isArray(c.skipped)) return { attempts: [{ status: 'skipped', ms: time }], status: 'skipped' };
    const attempts: TestAttempt[] = [...flaky.map((e): TestAttempt => ({ status: 'failed', ms: 0, error: errorOf(e) })), { status: 'passed', ms: time }];
    return { attempts, status: 'passed' };
}

/** The spec file a test belongs to: its own `file`, else the nearest suite's, else the nearest suite name that looks like a file. */
function specOf(c: Node, chain: Node[]): string | undefined {
    const own = attr(c, 'file');
    if (own) return own;
    for (let i = chain.length - 1; i >= 0; i--) {
        const f = attr(chain[i], 'file');
        if (f) return f;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
        const name = attr(chain[i], 'name');
        if (name && /\.[A-Za-z0-9]+$/.test(name)) return name;
    }
    return undefined;
}

export function parseJUnit(xml: string): SpecResult[] {
    let doc: Node;
    try {
        doc = parser.parse(xml) as Node;
    } catch {
        throw new Error('not a JUnit report: the text is not XML');
    }
    const root = doc?.testsuites ?? doc?.testsuite;
    if (!root || typeof root !== 'object') throw new Error('not a JUnit report: no testsuites or testsuite element');
    const roots: Node[] = doc.testsuites ? asNodes([doc.testsuites]).flatMap((t) => asNodes(t.testsuite)) : asNodes(doc.testsuite);

    const bySpec = new Map<string, TestResult[]>();
    const visit = (suite: Node, chain: Node[]) => {
        const here = [...chain, suite];
        for (const c of asNodes(suite.testcase)) {
            const spec = specOf(c, here) ?? '(unknown spec)';
            const { attempts, status } = attemptsOf(c);
            const tests = bySpec.get(spec) ?? [];
            tests.push({ title: attr(c, 'name') ?? '', status, attempts });
            bySpec.set(spec, tests);
        }
        for (const s of asNodes(suite.testsuite)) visit(s, here);
    };
    for (const s of roots) visit(s, []);
    return [...bySpec].map(([spec, tests]) => specResultOf(spec, tests, errorSignature));
}
