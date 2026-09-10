import { checkFix, isUsableFix } from './is-usable-fix';

describe('checkFix', () => {
    describe('no anchor code (PR-level / whole-file findings)', () => {
        it('does not flag an empty improvedCode when existingCode is also empty', () => {
            expect(checkFix('', '')).toBeNull();
            expect(checkFix(null, undefined)).toBeNull();
            expect(checkFix(undefined, '')).toBeNull();
        });
    });

    describe('empty', () => {
        it('flags an empty string', () => {
            expect(checkFix('const x = 1;', '')).toBe('empty');
        });

        it('flags whitespace-only', () => {
            expect(checkFix('const x = 1;', '   \n  ')).toBe('empty');
        });

        it('flags null/undefined', () => {
            expect(checkFix('const x = 1;', null)).toBe('empty');
            expect(checkFix('const x = 1;', undefined)).toBe('empty');
        });
    });

    describe('noop-fix', () => {
        it('flags byte-identical code', () => {
            const code = 'const result = data.map(x => x.value);';
            expect(checkFix(code, code)).toBe('noop-fix');
        });

        it('flags identical code after whitespace/indentation normalization', () => {
            const existingCode = '  const result = data.map(x => x.value);\n';
            const improvedCode = 'const result = data.map(x => x.value);';
            expect(checkFix(existingCode, improvedCode)).toBe('noop-fix');
        });

        it('does NOT flag a whitespace-only change inside a string literal', () => {
            // Only the message text changed (double space -> single space);
            // that is a real fix, not a formatting no-op, so collapsing
            // whitespace INSIDE the quotes must not make these compare equal.
            const existingCode = 'throw new Error("bad  input");';
            const improvedCode = 'throw new Error("bad input");';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });
    });

    describe('prose-only', () => {
        it('flags a comment describing the fix instead of code', () => {
            const existingCode = 'catch (e) { console.log(e); }';
            const improvedCode =
                '// re-throw the error here instead of swallowing it';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        it('flags a plain-English sentence with no code tokens', () => {
            const existingCode = 'if (user.role === "admin") grantAccess();';
            const improvedCode = 'Add a check for user.active before granting access';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        // Regression guard: these words were proposed as CODE_TOKEN_RE
        // additions and deliberately rejected — they are common enough in
        // plain English that adding them would let real prose slip through
        // as if it were a valid fix, which is the harm on the OTHER side of
        // this check.
        it.each([
            'this would break the existing tests',
            'wait for the promise to resolve first',
            'try adding a null check here instead',
            'this creates a new instance every time',
            'in that case the fallback should run',
        ])('still flags common-English prose containing %j', (improvedCode) => {
            const existingCode = 'if (user.role === "admin") grantAccess();';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });
    });

    describe('truncated', () => {
        it('flags unbalanced brackets', () => {
            const existingCode = 'function parseConfig(raw) {\n  return JSON.parse(raw);\n}';
            const improvedCode =
                'function parseConfig(raw) {\n  try {\n    return JSON.parse(raw);\n  } catch {\n    return safe default pa';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('flags an unterminated string literal', () => {
            const existingCode = 'const msg = "old value";';
            const improvedCode = 'const msg = "new value that got cut off';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('does NOT flag a bracket character that is inside a string literal', () => {
            // The literal ")" is message content, not an unclosed paren.
            const existingCode = 'const s = "x";';
            const improvedCode = 'const s = "x)";';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Regression guard: stripComments treats a "#" preceded by whitespace
        // as a line-comment marker (Python/Ruby), and running it on RAW code
        // that still contains string literals ate into a well-formed string
        // ("Error #1 occurred" -> "Error ", taking the closing quote with
        // it), which then registered as an unterminated-string false
        // positive. Comments must be stripped OUTSIDE string literals only.
        it('does NOT mistake a "#" inside a string literal for a comment marker', () => {
            const existingCode = 'const msg = "old error";';
            const improvedCode = 'const msg = "Error #1 occurred";';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('does NOT mistake a "//" preceded by whitespace inside a string for a comment marker', () => {
            const existingCode = 'const msg = "old note";';
            const improvedCode = 'const msg = "see docs // updated section";';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Rust: a lone "'" is not always a string opener — a lifetime marker
        // ('a, 'static) uses the same character but is never closed by a
        // matching quote. Without language awareness, two lifetimes on one
        // line get paired as if they were one string, swallowing the real
        // code between them — this is the literal signature under test.
        it('does NOT mistake Rust lifetime markers for an unterminated string (SUPPORTED_LANGUAGES: rust)', () => {
            const existingCode =
                "fn parse(input: &str) -> Result<&str, Error>";
            const improvedCode =
                "fn parse<'a>(input: &'a str) -> Result<&'a str, Error>";
            expect(checkFix(existingCode, improvedCode, 'rust')).toBeNull();
            expect(isUsableFix(existingCode, improvedCode, 'rust')).toBe(true);
        });

        it('still catches a genuinely unterminated Rust string (double-quoted)', () => {
            const existingCode = 'let msg = "old";';
            const improvedCode = 'let msg = "new value that got cut off';
            expect(checkFix(existingCode, improvedCode, 'rust')).toBe(
                'truncated',
            );
        });

        it('does not flag a dangling Rust "\'ident" — genuinely ambiguous with a real lifetime name', () => {
            // 'ab reads exactly like a (slightly unusual, but valid) Rust
            // lifetime name ('de, 'input, and friends are common in the
            // wild) — nothing in the text alone distinguishes it from a
            // truncated char literal, so the conservative call is not to
            // flag it, the same bias every other check here takes.
            const existingCode = "let c = 'a';";
            const improvedCode = "let c = 'ab";
            expect(checkFix(existingCode, improvedCode, 'rust')).toBeNull();
        });

        it('treats a lone "\'" as an unterminated literal for every OTHER language', () => {
            // Same shape as the Rust case above, but without language
            // context (or for a language where single-quote truly always
            // opens a string) a dangling "'" is a real truncation signal.
            const existingCode = "const x = 'a';";
            const improvedCode = "const x = 'ab";
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
            expect(checkFix(existingCode, improvedCode, 'javascript')).toBe(
                'truncated',
            );
        });

        it('does not flag a fix whose tail closes a block cleanly', () => {
            const existingCode = 'if (x) { doA(); }';
            const improvedCode = 'if (x) {\n  doA();\n  doB();\n}';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Regression guard for a real false positive the checker used to
        // have: a complete statement in a terminator-less style (no trailing
        // ";", "}", etc.) is NOT truncation. This bit real Python/Ruby code
        // and any no-semicolon JS/TS style — punctuation-tail sniffing was
        // dropped in favor of the structural (bracket/quote) check above.
        it('does not flag a complete no-semicolon statement as truncated', () => {
            const existingCode = 'const x = compute();';
            const improvedCode = 'const x = compute() + fallback';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('does not flag terminator-less Python as truncated', () => {
            const existingCode = 'return None';
            const improvedCode = 'return default_value';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });
    });

    describe('usable fixes', () => {
        it('accepts a real single-line fix', () => {
            const existingCode = 'const result = data.map(x => x.value);';
            const improvedCode = 'const result = data?.map(x => x.value) ?? [];';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
            expect(isUsableFix(existingCode, improvedCode)).toBe(true);
        });

        it('accepts a real multi-line fix', () => {
            const existingCode = 'catch (e) { console.log(e); }';
            const improvedCode = 'catch (e) {\n  throw e;\n}';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('accepts code that legitimately contains a trailing string literal', () => {
            const existingCode = 'const msg = "old";';
            const improvedCode = 'const msg = "new value";';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('does not misread a fix ending in a comment as prose-only', () => {
            const existingCode = 'const x = 1;';
            const improvedCode = 'const x = 1; // fixed the off-by-one';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // These previously registered as false "prose-only" positives: none
        // of them contain ;{}()=<> or the original keyword list.
        it('accepts a bare Python import with no other punctuation', () => {
            const existingCode = 'import sys';
            const improvedCode = 'import os';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('accepts a bare Python elif with no other punctuation', () => {
            const existingCode = 'if x: pass';
            const improvedCode = 'elif y: pass';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('accepts a fix that is only a corrected message string', () => {
            const existingCode = '"Invalid input"';
            const improvedCode = '"Invalid configuration provided"';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Bare control-flow statements: complete, valid, and carry neither
        // punctuation nor a CODE_TOKEN_RE keyword in several languages.
        it.each([
            ['break', 'do_something()'],
            ['continue', 'do_something()'],
            ['pass', 'do_something()'], // Python
            ['raise', 'log_and_continue()'], // Python bare re-raise
            ['next', 'do_something'], // Ruby
            ['redo', 'do_something'], // Ruby
            ['retry', 'do_something'], // Ruby
            ['fallthrough', 'do_something()'], // Go
        ])('accepts a bare "%s" statement as the whole fix', (bareFix, existing) => {
            expect(checkFix(existing, bareFix)).toBeNull();
        });

        it('still flags "break" embedded in an ordinary English sentence as prose', () => {
            const existingCode = 'do_something()';
            const improvedCode = 'this would break the existing tests';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });
    });
});
