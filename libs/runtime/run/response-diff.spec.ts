import { REDACTED, RESPONSE_DIFF_MAX_FIELDS, responseDiffOf, responseTextSample } from './response-diff';

const none = (s: string) => s;

describe('responseDiffOf', () => {
    it('lists the JSON fields whose values differ, the gate\'s decisive ones first, with both values', () => {
        const d = responseDiffOf({
            base: { fields: { status: '200', 'json.a': '1', 'json.branch': '"main"', 'json.same': 'true' } },
            pr: { fields: { status: '200', 'json.a': '2', 'json.branch': '"feature"', 'json.same': 'true', 'json.extra': 'null' } },
            differing: ['json.branch'],
            clean: none,
        });
        expect(d).toEqual({
            fields: [
                { path: 'json.branch', base: '"main"', pr: '"feature"' },
                { path: 'json.a', base: '1', pr: '2' },
                { path: 'json.extra', pr: 'null' },
            ],
            truncated: false,
        });
    });

    it('leaves out what the base itself varied on, and answers nothing when the rest matches', () => {
        expect(responseDiffOf({ base: { fields: { 'json.at': '1' } }, pr: { fields: { 'json.at': '2' } }, masked: ['json.at'], clean: none })).toBeUndefined();
    });

    it('always redacts header and secret-looking keys, at any depth, and cleans and cuts every value', () => {
        const d = responseDiffOf({
            base: { fields: { 'json.user.apiKey': '"k1"', 'json.items': JSON.stringify([{ token: 't1', n: 1 }]), 'json.note': `"${'a'.repeat(300)}"` } },
            pr: { fields: { 'json.user.apiKey': '"k2"', 'json.items': JSON.stringify([{ token: 't2', n: 2 }]), 'json.note': '"ghp_secret"' } },
            clean: (s) => s.replace('ghp_secret', '[redacted:github-pat]'),
        })!;
        const by = Object.fromEntries(d.fields.map((f) => [f.path, f]));
        expect(by['json.user.apiKey']).toEqual({ path: 'json.user.apiKey', base: REDACTED, pr: REDACTED });
        expect(by['json.items'].base).toBe(JSON.stringify([{ token: REDACTED, n: 1 }]));
        expect(by['json.note'].base!.length).toBe(200);
        expect(by['json.note'].base!.endsWith('…')).toBe(true);
        expect(by['json.note'].pr).toBe('"[redacted:github-pat]"');
    });

    it('keeps at most 20 fields and says it cut the rest', () => {
        const base: Record<string, string> = {};
        const pr: Record<string, string> = {};
        for (let i = 0; i < 25; i++) {
            base[`json.f${String(i).padStart(2, '0')}`] = '1';
            pr[`json.f${String(i).padStart(2, '0')}`] = '2';
        }
        const d = responseDiffOf({ base: { fields: base }, pr: { fields: pr }, clean: none })!;
        expect(d.fields).toHaveLength(RESPONSE_DIFF_MAX_FIELDS);
        expect(d.truncated).toBe(true);
    });

    it('shows the first differing line of a body that is not JSON', () => {
        const d = responseDiffOf({
            base: { fields: { json: 'not_json' }, text: responseTextSample('<html>\n<p>main</p>\n</html>', none) },
            pr: { fields: { json: 'not_json' }, text: responseTextSample('<html>\n<p>feature</p>\n</html>', none) },
            clean: none,
        });
        expect(d).toEqual({ fields: [{ path: 'line 2', base: '"<p>main</p>"', pr: '"<p>feature</p>"' }], truncated: false });
    });

    it('says only that it was cut when a text body differs past what was kept', () => {
        const long = (last: string) => responseTextSample([...Array.from({ length: 300 }, () => 'same'), last].join('\n'), none);
        expect(responseDiffOf({ base: { fields: {}, text: long('a') }, pr: { fields: {}, text: long('b') }, clean: none })).toEqual({ fields: [], truncated: true });
    });

    it('names the body when one side answered JSON and the other did not', () => {
        const d = responseDiffOf({ base: { fields: { 'json.ok': 'true' } }, pr: { fields: { json: 'not_json' }, text: { lines: ['', 'Internal Server Error'], truncated: false } }, clean: none });
        expect(d).toEqual({ fields: [{ path: 'body', base: '"JSON body"', pr: '"Internal Server Error"' }], truncated: false });
    });
});
