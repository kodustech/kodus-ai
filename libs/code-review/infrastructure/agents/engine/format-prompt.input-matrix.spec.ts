import { parseFormatResponse } from './format-prompt';

/**
 * The input space of `parseFormatResponse`, enumerated instead of sampled.
 *
 * Six rounds of review found six defects in this function and in the sanitiser
 * beside it, and all six were the same shape: a case where the code should have
 * REFUSED and did not, or should have RECOVERED and did not. Every one of them
 * was reachable from a dimension the tests never varied — a hole in an array, a
 * label in prose, an object in front of the JSON, an array nested inside that
 * object.
 *
 * The reason is method, not luck. Tests written from the fix's point of view
 * ("what should this do?") enumerate variations of the case being fixed, and
 * agree with each other because they share one hypothesis. Tests written from
 * the INPUT's point of view ("what can arrive here?") have to name the values
 * of each dimension, including the ones the fix was never about.
 *
 * So the dimensions are named here, and every combination that matters carries
 * an explicit verdict:
 *
 *   - what PRECEDES the JSON: nothing, prose, an object, a fence, an object
 *     that carries its own array
 *   - what WRAPS it: nothing, a known alias, an unknown key, a double wrapper
 *   - how it is ENCODED: direct, inside a JSON string, doubly so
 *   - how it is MALFORMED: trailing comma, single quotes, unquoted keys
 *   - whether it is an ANSWER AT ALL: a refusal, a refusal containing a
 *     bracket, empty, whitespace
 *
 * `REAL` is the marker for the array the model actually meant. A case that
 * recovers anything else — a decoy, a fragment — fails, which is the assertion
 * that was missing when a nested decoy shipped to a pull request as the review.
 */

const REAL = '[{"index":0,"suggestionContent":"REAL"}]';

type Verdict = { recovers: true } | { recovers: false };

const recovers = (): Verdict => ({ recovers: true });
const refuses = (): Verdict => ({ recovers: false });

const CASES: Array<[string, string, Verdict]> = [
    // ---- what precedes the JSON -------------------------------------------
    ['nothing', REAL, recovers()],
    ['prose', `Here you go:\n${REAL}`, recovers()],
    ['a note object', `{"note":"here you go"} ${REAL}`, recovers()],
    ['a fenced block', '```\n{"note":"a"}\n```\n' + REAL, recovers()],
    ['a fence around the answer', '```json\n' + REAL + '\n```', recovers()],
    [
        'an object carrying its own suggestion-shaped array (decoy)',
        `{"a":[{"index":0,"suggestionContent":"DECOY"}],"b":1} ${REAL}`,
        recovers(),
    ],
    [
        'a bracket inside a leading string',
        `{"note":"[not json]"} ${REAL}`,
        recovers(),
    ],
    ['prose after the array', `${REAL}\nThat is all.`, recovers()],

    // ---- what wraps it ------------------------------------------------------
    [
        'a known alias: suggestions',
        '{"suggestions":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'a known alias: result',
        '{"result":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'a known alias: data',
        '{"data":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'a double wrapper',
        '{"result":{"result":[{"index":0,"suggestionContent":"REAL"}]}}',
        recovers(),
    ],
    [
        'an unknown key wrapping the array',
        '{"whatever":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'an object holding TWO arrays (no basis for choosing)',
        '{"a":[{"index":0,"suggestionContent":"DECOY"}],"b":[{"index":0,"suggestionContent":"REAL"}]}',
        refuses(),
    ],
    [
        'an object holding no array at all',
        '{"note":"nothing here","n":1}',
        refuses(),
    ],

    // ---- what precedes it CROSSED with what wraps it ----------------------
    // The two dimensions above were only ever varied one at a time, so every
    // cell of their product went untested. Three of them refused a recovery
    // that is unambiguous, and the fourth returned the DECOY: with both
    // brackets nested, the top-level scan finds nothing and the wrapper rule
    // decides alone, so reading only the FIRST balanced value picked the
    // leading object's array. Wrong content as the review, reached through
    // the guard built to stop exactly that.
    [
        'a note object before a WRAPPED array',
        '{"note":"x"} {"suggestions":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'prose before a wrapped array',
        'Here you go:\n{"suggestions":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'a fenced block before a wrapped array',
        '```\n{"note":"a"}\n```\n{"suggestions":[{"index":0,"suggestionContent":"REAL"}]}',
        recovers(),
    ],
    [
        'a DECOY-carrying object before a wrapped array',
        '{"a":[{"index":0,"suggestionContent":"DECOY"}]} {"suggestions":[{"index":0,"suggestionContent":"REAL"}]}',
        refuses(),
    ],

    // ---- how it is encoded --------------------------------------------------
    [
        'JSON inside a JSON string',
        '"[{\\"index\\": 0, \\"suggestionContent\\": \\"REAL\\"}]"',
        recovers(),
    ],

    // ---- how it is malformed ------------------------------------------------
    [
        'a trailing comma',
        '[{"index":0,"suggestionContent":"REAL"},]',
        recovers(),
    ],
    [
        'single quotes (JavaScript, not JSON)',
        "[{'index':0,'suggestionContent':'REAL'}]",
        refuses(),
    ],
    [
        'unquoted keys (JavaScript, not JSON)',
        '[{index:0,suggestionContent:"REAL"}]',
        refuses(),
    ],
    ['a truncated array', '[{"index":0,"suggestionContent":"RE', refuses()],

    // ---- items that do not match the contract -------------------------------
    ['an empty array', '[]', refuses()],
    ['items with the wrong keys', '[{"foo":"bar"}]', refuses()],
    [
        'items missing suggestionContent',
        '[{"index":0,"improvedCode":"x"}]',
        refuses(),
    ],
    [
        'a non-numeric index',
        '[{"index":"0","suggestionContent":"REAL"}]',
        refuses(),
    ],
    ['an array of strings', '["REAL"]', refuses()],
    ['an array of nulls', '[null,null]', refuses()],

    // ---- not an answer at all -----------------------------------------------
    ['a refusal', 'I cannot help with that.', refuses()],
    ['a refusal containing a bracket', 'I cannot help [see policy].', refuses()],
    ['an empty string', '', refuses()],
    ['whitespace only', '   \n\t ', refuses()],
    ['a bare object', '{"index":0,"suggestionContent":"REAL"}', refuses()],
    ['a bare number', '42', refuses()],
];

describe('parseFormatResponse — the input space, enumerated', () => {
    it.each(CASES)('%s', (_label, input, verdict) => {
        const { formatted, parseOk } = parseFormatResponse(input);

        expect(parseOk).toBe(verdict.recovers);

        if (verdict.recovers) {
            // Recovering SOMETHING is not enough — it has to be the array the
            // model meant. A decoy that parses cleanly is the failure that
            // shipped fabricated content to a customer's pull request.
            expect(formatted.get(0)?.suggestionContent).toBe('REAL');
        } else {
            expect(formatted.size).toBe(0);
        }
    });

    it('covers every dimension it claims to', () => {
        // A matrix that quietly loses a row is worse than no matrix: it reads
        // as coverage while testing less than it says.
        expect(CASES).toHaveLength(36);
        expect(CASES.filter(([, , v]) => v.recovers)).toHaveLength(18);
        expect(CASES.filter(([, , v]) => !v.recovers)).toHaveLength(18);
    });
});
