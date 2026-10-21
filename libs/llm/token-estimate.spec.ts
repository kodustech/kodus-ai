/**
 * Mutation-killing spec for estimateTextTokens + FALLBACK_CHARS_PER_TOKEN.
 *
 * `tiktoken` is fully mocked so the tests are deterministic (no WASM) and can
 * drive every branch of the estimator:
 *   - the `!text` guard (returns 0 before the encoder is ever consulted),
 *   - the encoder success path (exact encode_ordinary length, 'o200k_base'),
 *   - the encoder-load-failure fallback (get_encoding throws, never retries),
 *   - the encode-throw fallback (encoder present but encode_ordinary throws),
 *   - the Math.ceil(len / FALLBACK_CHARS_PER_TOKEN) arithmetic + boundaries.
 *
 * The module keeps encoder state in module-level singletons (`encoder`,
 * `encoderFailed`), so each scenario is run inside jest.isolateModules to get a
 * fresh module (and a fresh tiktoken mock) with clean caching state.
 */

jest.mock('tiktoken', () => ({
    get_encoding: jest.fn(),
    // `type Tiktoken` is a type-only import; nothing to mock for it at runtime.
}));

/**
 * Run `body` against a freshly-required token-estimate module. `configure`
 * receives the fresh tiktoken.get_encoding jest.fn so the test can set its
 * behavior BEFORE estimateTextTokens is called (getEncoder is lazy).
 */
function withFreshModule(configure, body) {
    jest.isolateModules(() => {
        const tiktoken = require('tiktoken');
        configure(tiktoken.get_encoding);
        const mod = require('./token-estimate');
        body(mod, tiktoken.get_encoding);
    });
}

/** Encoder stub whose encode_ordinary always returns an array of `len`. */
function fixedLengthEncoder(len, spy?) {
    return {
        encode_ordinary: (text) => {
            if (spy) {
                spy(text);
            }
            return new Array(len);
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('FALLBACK_CHARS_PER_TOKEN', () => {
    it('is exactly 3 (the conservative code-density ratio the fallback divides by)', () => {
        const { FALLBACK_CHARS_PER_TOKEN } = require('./token-estimate');
        expect(FALLBACK_CHARS_PER_TOKEN).toBe(3);
    });
});

describe('estimateTextTokens — falsy guard', () => {
    it('returns 0 for empty string even when the encoder would return non-zero', () => {
        withFreshModule(
            (getEncoding) => {
                // Encoder would report 5 tokens for ANY input; the guard must win.
                getEncoding.mockReturnValue(fixedLengthEncoder(5));
            },
            ({ estimateTextTokens }, getEncoding) => {
                expect(estimateTextTokens('')).toBe(0);
                // Guard short-circuits before the encoder is ever consulted.
                expect(getEncoding).not.toHaveBeenCalled();
            },
        );
    });

    it('returns 0 for null and undefined', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockReturnValue(fixedLengthEncoder(5));
            },
            ({ estimateTextTokens }) => {
                expect(estimateTextTokens(null)).toBe(0);
                expect(estimateTextTokens(undefined)).toBe(0);
            },
        );
    });

    it('does NOT short-circuit a non-empty string (guard is !text, not always-true)', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockReturnValue(fixedLengthEncoder(5));
            },
            ({ estimateTextTokens }) => {
                // A single non-empty char must reach the encoder → 5, not 0.
                expect(estimateTextTokens('x')).toBe(5);
            },
        );
    });
});

describe('estimateTextTokens — encoder success path', () => {
    it('returns the EXACT encode_ordinary length, not the char fallback', () => {
        const encodeSpy = jest.fn();
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockReturnValue(fixedLengthEncoder(11, encodeSpy));
            },
            ({ estimateTextTokens }) => {
                // 'abcdef' has length 6 → fallback would be ceil(6/3)=2. Encoder wins → 11.
                expect(estimateTextTokens('abcdef')).toBe(11);
                expect(encodeSpy).toHaveBeenCalledWith('abcdef');
            },
        );
    });

    it('requests the o200k_base encoding specifically', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockReturnValue(fixedLengthEncoder(3));
            },
            ({ estimateTextTokens }, getEncoding) => {
                estimateTextTokens('hello');
                expect(getEncoding).toHaveBeenCalledWith('o200k_base');
            },
        );
    });

    it('caches the encoder — get_encoding is called once across many estimates', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockReturnValue(fixedLengthEncoder(4));
            },
            ({ estimateTextTokens }, getEncoding) => {
                expect(estimateTextTokens('one')).toBe(4);
                expect(estimateTextTokens('two')).toBe(4);
                expect(estimateTextTokens('three')).toBe(4);
                expect(getEncoding).toHaveBeenCalledTimes(1);
            },
        );
    });
});

describe('estimateTextTokens — fallback when encoder cannot load', () => {
    it('falls back to ceil(len / 3) when get_encoding throws', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockImplementation(() => {
                    throw new Error('WASM unavailable');
                });
            },
            ({ estimateTextTokens }) => {
                // length 7 → ceil(7/3) = 3.
                expect(estimateTextTokens('abcdefg')).toBe(3);
            },
        );
    });

    it('never retries get_encoding after a load failure (encoderFailed latch)', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockImplementation(() => {
                    throw new Error('WASM unavailable');
                });
            },
            ({ estimateTextTokens }, getEncoding) => {
                expect(estimateTextTokens('abcdefg')).toBe(3);
                expect(estimateTextTokens('abcdefg')).toBe(3);
                expect(estimateTextTokens('abcdefg')).toBe(3);
                // Latched failure: get_encoding is attempted exactly once, not per call.
                expect(getEncoding).toHaveBeenCalledTimes(1);
            },
        );
    });
});

describe('estimateTextTokens — fallback when encode_ordinary throws', () => {
    it('falls through to the char estimate when the encoder throws mid-encode', () => {
        withFreshModule(
            (getEncoding) => {
                getEncoding.mockReturnValue({
                    encode_ordinary: () => {
                        throw new Error('encode boom');
                    },
                });
            },
            ({ estimateTextTokens }) => {
                // length 10 → ceil(10/3) = 4.
                expect(estimateTextTokens('abcdefghij')).toBe(4);
            },
        );
    });
});

describe('estimateTextTokens — fallback arithmetic (Math.ceil, divisor 3)', () => {
    // All of these force the fallback path via a throwing get_encoding, then
    // pin the exact ceil(len / 3) result to kill divisor and rounding mutants.
    const cases = [
        { text: 'abc', len: 3, expected: 1 }, // 3/3 = 1 exact
        { text: 'abcd', len: 4, expected: 2 }, // 4/3 = 1.33 → ceil 2 (floor/round would be 1)
        { text: 'abcde', len: 5, expected: 2 }, // 5/3 = 1.66 → ceil 2 (floor would be 1)
        { text: 'abcdef', len: 6, expected: 2 }, // 6/3 = 2 exact (kills /2 → 3, /4 → 2? 6/4=1.5→2, use 12 below)
        { text: 'abcdefg', len: 7, expected: 3 }, // 7/3 = 2.33 → ceil 3
        { text: 'abcdefghijkl', len: 12, expected: 4 }, // 12/3=4; /4 would give 3, /2 would give 6
    ];

    for (const { text, len, expected } of cases) {
        it(`ceil(${len}/3) === ${expected}`, () => {
            expect(text.length).toBe(len); // sanity: input length is what we think
            withFreshModule(
                (getEncoding) => {
                    getEncoding.mockImplementation(() => {
                        throw new Error('no wasm');
                    });
                },
                ({ estimateTextTokens }) => {
                    expect(estimateTextTokens(text)).toBe(expected);
                },
            );
        });
    }
});
