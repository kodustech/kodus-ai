import { parseMochawesome } from './mochawesome';

// Invented fixture in the shape of Mochawesome's JSON: results are spec files,
// each with nested suites of tests.
const REPORT = JSON.stringify({
    stats: { tests: 4 },
    results: [
        {
            file: 'cypress/e2e/profile.cy.ts',
            fullFile: '/work/app/cypress/e2e/profile.cy.ts',
            suites: [
                {
                    title: 'Profile',
                    tests: [
                        { title: 'shows the name', fullTitle: 'Profile shows the name', state: 'passed', pass: true, fail: false, pending: false, duration: 1200, err: {} },
                        {
                            title: 'saves the bio',
                            fullTitle: 'Profile saves the bio',
                            state: 'failed',
                            pass: false,
                            fail: true,
                            pending: false,
                            duration: 3400,
                            err: { message: 'expected 1 to equal 2', estack: 'AssertionError: expected 1 to equal 2\n    at x' },
                        },
                    ],
                    suites: [
                        {
                            title: 'Avatar',
                            tests: [
                                { title: 'uploads', fullTitle: 'Profile Avatar uploads', pass: false, fail: false, pending: true, duration: 0, err: {} },
                            ],
                            suites: [],
                        },
                    ],
                },
            ],
        },
        {
            file: 'cypress/e2e/home.cy.ts',
            suites: [{ title: 'Home', tests: [{ title: 'loads', fullTitle: 'Home loads', state: 'passed', pass: true, duration: 800, err: {} }], suites: [] }],
        },
        { file: 'cypress/e2e/empty.cy.ts', suites: [] },
    ],
});

describe('parseMochawesome', () => {
    const specs = parseMochawesome(REPORT);
    const profile = specs.find((s) => s.spec === 'cypress/e2e/profile.cy.ts')!;

    it('gives one result per spec file, with tests found through nested suites', () => {
        expect(specs.map((s) => s.spec)).toEqual(['cypress/e2e/profile.cy.ts', 'cypress/e2e/home.cy.ts']);
        expect(profile.tests.map((t) => t.title)).toEqual(['Profile shows the name', 'Profile saves the bio', 'Profile Avatar uploads']);
    });
    it('marks the failed test failed with the error text, and the spec failed', () => {
        const t = profile.tests[1];
        expect(t.status).toBe('failed');
        expect(t.attempts[0].error).toContain('AssertionError: expected 1 to equal 2');
        expect(profile.status).toBe('failed');
    });
    it('marks a pending test pending and reads durations', () => {
        expect(profile.tests[2].status).toBe('pending');
        expect(profile.tests[0].attempts[0].ms).toBe(1200);
        expect(profile.durationMs).toBe(4600);
    });
    it('drops a spec that ran no test', () => {
        expect(specs.some((s) => s.spec === 'cypress/e2e/empty.cy.ts')).toBe(false);
    });
    it('refuses text that is not a Mochawesome report', () => {
        expect(() => parseMochawesome('{"x":1}')).toThrow(/Mochawesome/);
        expect(() => parseMochawesome('nope')).toThrow(/Mochawesome/);
    });
});
