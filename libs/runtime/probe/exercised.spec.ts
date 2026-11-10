import { browserStepTargetOf, exercisedOf, MAX_EXERCISED, MAX_STEP_TARGET } from './exercised';

const target = { service: 'app', port: 3000 };

describe('exercisedOf', () => {
    it('names an http probe by method and path, without query or fragment', () => {
        expect(exercisedOf({ kind: 'http', target, method: 'GET', path: '/api/health?token=abc#x' })).toBe('GET /api/health');
    });

    it('redacts a secret in the path', () => {
        const label = exercisedOf({ kind: 'http', target, method: 'POST', path: '/hooks/ghp_abcdefghijklmnopqrstuvwxyz0123456789' })!;
        expect(label).not.toContain('ghp_');
        expect(label.startsWith('POST /hooks/')).toBe(true);
    });

    it('names a browser probe by its first goto, and sql by its service', () => {
        expect(exercisedOf({ kind: 'browser', steps: [{ click: '#a' }, { goto: '/login' }, { goto: '/home' }], viewport: { width: 800, height: 600 } })).toBe('browser /login');
        expect(exercisedOf({ kind: 'browser', steps: [{ click: '#a' }], viewport: { width: 800, height: 600 } })).toBeUndefined();
        expect(exercisedOf({ kind: 'sql', target: { service: 'db', port: 5432 }, query: 'SELECT 1' })).toBe('SQL on db');
    });

    it('gives a shell probe no label and keeps every label bounded', () => {
        expect(exercisedOf({ kind: 'shell', command: 'ls' })).toBeUndefined();
        expect(exercisedOf({ kind: 'http', target, method: 'GET', path: `/${'a'.repeat(2_000)}` })!.length).toBe(MAX_EXERCISED);
    });
});

describe('browserStepTargetOf', () => {
    it('names what a step acts on from the probe step, never the text it types or expects', () => {
        expect(browserStepTargetOf({ expectText: ['#orders', 'keyboard'] })).toBe('#orders');
        expect(browserStepTargetOf({ fill: ['#password', 'hunter2'] })).toBe('#password');
        expect(browserStepTargetOf({ getAttribute: ['#place', 'aria-label'] })).toBe('#place');
        expect(browserStepTargetOf({ click: 'button[type=submit]' })).toBe('button[type=submit]');
        expect(browserStepTargetOf({ goto: '/login?token=abc#x' })).toBe('/login');
        expect(browserStepTargetOf({ press: 'Enter' })).toBe('Enter');
        expect(browserStepTargetOf({ screenshot: 'orders' })).toBe('orders');
        expect(browserStepTargetOf(undefined)).toBeUndefined();
    });

    it('redacts a secret, flattens line breaks and stays within 128 characters', () => {
        expect(browserStepTargetOf({ click: 'a[href*=ghp_abcdefghijklmnopqrstuvwxyz0123456789]' })).not.toContain('ghp_');
        expect(browserStepTargetOf({ click: '#a\n#b' })).toBe('#a #b');
        expect(browserStepTargetOf({ click: `#${'a'.repeat(1_000)}` })!.length).toBe(MAX_STEP_TARGET);
    });
});
