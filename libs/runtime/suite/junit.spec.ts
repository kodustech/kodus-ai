import { parseJUnit } from './junit';

// Invented fixture in the shape of mocha-junit-reporter (Cypress) and of the
// Playwright JUnit reporter: one failed, one skipped, one retried-then-passed.
const CYPRESS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" time="12.5" tests="4" failures="1">
  <testsuite name="Root Suite" timestamp="2026-01-01T00:00:00" tests="0" time="0">
  </testsuite>
  <testsuite name="Cart" timestamp="2026-01-01T00:00:00" file="cypress/e2e/cart.cy.ts" tests="3" failures="1" skipped="1" time="9.0">
    <testcase name="Cart adds an item" time="3.2" classname="adds an item"></testcase>
    <testcase name="Cart removes an item" time="4.8" classname="removes an item">
      <failure message="Timed out retrying after 4000ms: Expected to find element: &#96;.empty-cart&#96;" type="AssertionError"><![CDATA[AssertionError: Timed out retrying after 4000ms
    at Context.eval (cypress/e2e/cart.cy.ts:20:5)]]></failure>
    </testcase>
    <testcase name="Cart applies a coupon" time="0" classname="applies a coupon"><skipped/></testcase>
  </testsuite>
  <testsuite name="Login" file="cypress/e2e/login.cy.ts" tests="1" time="3.5">
    <testcase name="Login signs in" time="3.5" classname="signs in"></testcase>
  </testsuite>
</testsuites>`;

const PLAYWRIGHT = `<testsuites>
  <testsuite name="search.spec.ts" tests="2" failures="0" time="5">
    <testcase name="search › finds a product" classname="search.spec.ts" time="2.5">
      <flakyFailure message="locator timeout" type="Error"><![CDATA[Error: locator timeout
    at search.spec.ts:9:3]]></flakyFailure>
    </testcase>
    <testcase name="search › empty query" classname="search.spec.ts" time="2.5"></testcase>
  </testsuite>
  <testsuite name="checkout.spec.ts" tests="1" failures="1" time="9">
    <testcase name="checkout › pays" classname="checkout.spec.ts" time="9">
      <failure message="expected 3 got 4" type="Error">Error: expected 3 got 4</failure>
      <rerunFailure message="expected 3 got 5" type="Error">Error: expected 3 got 5</rerunFailure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('parseJUnit', () => {
    describe('a Cypress file', () => {
        const specs = parseJUnit(CYPRESS);
        const cart = specs.find((s) => s.spec === 'cypress/e2e/cart.cy.ts')!;

        it('gives one result per spec file, skipping suites that hold no test', () => {
            expect(specs.map((s) => s.spec).sort()).toEqual(['cypress/e2e/cart.cy.ts', 'cypress/e2e/login.cy.ts']);
        });
        it('marks the failed test with its error and the spec failed', () => {
            const t = cart.tests.find((x) => x.title === 'Cart removes an item')!;
            expect(t.status).toBe('failed');
            expect(t.attempts).toHaveLength(1);
            expect(t.attempts[0].status).toBe('failed');
            expect(t.attempts[0].error).toContain('Timed out retrying after 4000ms');
            expect(cart.status).toBe('failed');
        });
        it('marks a skipped test skipped and keeps its passing siblings passed', () => {
            expect(cart.tests.find((x) => x.title === 'Cart applies a coupon')!.status).toBe('skipped');
            expect(cart.tests.find((x) => x.title === 'Cart adds an item')!.status).toBe('passed');
        });
        it('reads durations in milliseconds, summed per spec', () => {
            expect(cart.tests.find((x) => x.title === 'Cart adds an item')!.attempts[0].ms).toBe(3200);
            expect(cart.durationMs).toBe(8000);
        });
        it('says passed for a spec whose tests all passed', () => {
            expect(specs.find((s) => s.spec === 'cypress/e2e/login.cy.ts')!.status).toBe('passed');
        });
    });

    describe('a Playwright file', () => {
        const specs = parseJUnit(PLAYWRIGHT);

        it('keeps a retried-then-passed test as passed with both attempts, so it is flaky in the run', () => {
            const t = specs.find((s) => s.spec === 'search.spec.ts')!.tests.find((x) => x.title === 'search › finds a product')!;
            expect(t.status).toBe('passed');
            expect(t.attempts.map((a) => a.status)).toEqual(['failed', 'passed']);
            expect(t.attempts[0].error).toContain('locator timeout');
        });
        it('keeps every attempt of a test that failed through its retries', () => {
            const t = specs.find((s) => s.spec === 'checkout.spec.ts')!.tests[0];
            expect(t.status).toBe('failed');
            expect(t.attempts.map((a) => a.status)).toEqual(['failed', 'failed']);
            expect(t.attempts[1].error).toContain('expected 3 got 5');
        });
    });

    it('takes a single testsuite as the root', () => {
        const specs = parseJUnit('<testsuite name="a.cy.ts" file="a.cy.ts"><testcase name="x" time="1"/></testsuite>');
        expect(specs).toHaveLength(1);
        expect(specs[0].tests[0].status).toBe('passed');
    });

    it('treats an error element as a failure', () => {
        const [s] = parseJUnit('<testsuite name="a.cy.ts" file="a.cy.ts"><testcase name="x" time="1"><error message="boom"/></testcase></testsuite>');
        expect(s.tests[0].status).toBe('failed');
        expect(s.tests[0].attempts[0].error).toBe('boom');
    });

    it('merges testsuites of the same spec file into one result', () => {
        const specs = parseJUnit(
            '<testsuites><testsuite name="A" file="a.cy.ts"><testcase name="A one" time="1"/></testsuite><testsuite name="B" file="a.cy.ts"><testcase name="B two" time="1"/></testsuite></testsuites>',
        );
        expect(specs).toHaveLength(1);
        expect(specs[0].tests).toHaveLength(2);
    });

    it('refuses a document that is not JUnit', () => {
        expect(() => parseJUnit('<html></html>')).toThrow(/JUnit/);
        expect(() => parseJUnit('not xml at all')).toThrow(/JUnit/);
    });
});
