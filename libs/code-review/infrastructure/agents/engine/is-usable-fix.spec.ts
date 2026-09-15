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

        it('does NOT flag a whitespace-only change inside a Ruby %w[] literal', () => {
            const existingCode = 'list = %w[a  b]';
            const improvedCode = 'list = %w[a b]';
            expect(checkFix(existingCode, improvedCode, 'ruby')).toBeNull();
        });

        it('does NOT flag a whitespace-only change inside typographic/"smart" quotes', () => {
            // SAME words either side — only whitespace differs — so this
            // only stays usable if the quoted content is genuinely
            // protected; using different words either side would pass for
            // the wrong reason (they are never a noop regardless).
            const existingCode = 'msg = “old  text”';
            const improvedCode = 'msg = “old text”';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });
    });

    // Prose-only detection (was this text English or code?) was removed
    // entirely after seven review rounds of keyword lists, stop-word gates,
    // and label vocabularies each fixed one false positive by opening a new
    // false negative — see the file header. "Fix: return x;" and similar
    // scaffolding-prefixed text now simply ships (or gets caught by the
    // truncated/empty/noop checks below on its own, unrelated merits); it is
    // no longer this gate's job to guess whether a string "reads like" code.

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

        // Kody's own review caught this: removing the old, over-broad
        // endsMidToken check for issue #1568's Python/Ruby/no-semi false
        // positives also removed the ONLY thing that caught the issue's own
        // motivating example — a truncated tail with no unclosed bracket.
        it('flags a bare truncated return value (the literal issue #1833 example, standalone)', () => {
            const existingCode = 'return null;';
            const improvedCode = 'return safe default pa';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('does NOT flag "return x" — a complete, single-expression return', () => {
            const existingCode = 'return null;';
            const improvedCode = 'return default_value';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Kody's own review caught this: the bare-word-run check above did
        // not know Python spells several operators as words, not symbols —
        // these are all valid, COMPLETE Python, not truncated.
        it.each([
            ['yield from old_gen', 'yield from gen'],
            ['return not y', 'return not x'],
            ['return a if b else c', 'return x if y else z'],
            ['return a and b', 'return x and y'],
            ['return a is None', 'return x is None'],
        ])('does NOT flag valid multi-word Python return/yield (%j -> %j)', (existingCode, improvedCode) => {
            expect(checkFix(existingCode, improvedCode, 'python')).toBeNull();
        });

        // Kody's own review caught this: the connector exemption above was
        // too broad — it also exempted a run that DANGLES on a connector
        // word ("return a if", with nothing after "if"), which is just as
        // truncated as the plain word-run case, only with a keyword instead
        // of an identifier as the last word.
        it.each([
            'return a if',
            'return x and',
            'return a is',
            'return x in',
        ])('flags a truncated tail dangling on a connector word (%j)', (improvedCode) => {
            expect(checkFix('return b;', improvedCode, 'python')).toBe('truncated');
        });

        it('does NOT flag "var x int" (Go) — a valid multi-word declaration, not return/yield', () => {
            const existingCode = 'var x string';
            const improvedCode = 'var x int';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it.each([
            'const x = 1 +',
            'const x =',
            'const f = x =>',
            'const x: Array<',
        ])('flags a tail ending mid-operator (%j)', (improvedCode) => {
            const existingCode = 'const x = 1;';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('does NOT flag a fix whose real (comment/literal-aware) ending is a closing generic ">"', () => {
            // ">" alone is routinely how a COMPLETE generic type ends
            // (Rust/TypeScript/Java/C#) — only the 2-char arrow "=>" counts
            // as a dangling operator, not a bare trailing ">".
            const existingCode = 'fn parse(input: &str) -> Result<&str, Error>';
            const improvedCode =
                "fn parse<'a>(input: &'a str) -> Result<&'a str, Error>";
            expect(checkFix(existingCode, improvedCode, 'rust')).toBeNull();
        });

        it('does NOT misread the operator preceding a trailing literal as dangling', () => {
            // "=" is followed by real, protected content ("%w[a b]"), not
            // nothing — stripping that content for the bracket/quote scan
            // must not make the "=" that came before it look truncated.
            const existingCode = 'list = %w[a]';
            const improvedCode = 'list = %w[a b c]';
            expect(checkFix(existingCode, improvedCode, 'ruby')).toBeNull();
        });

        // Kody's own review caught this too: a JS/TS regex literal's quote
        // characters are a character class, not an unterminated string.
        it('does NOT flag a regex literal containing quote characters', () => {
            const existingCode = 'const hasQuote = /[a-z]/.test(x);';
            const improvedCode = "const hasQuote = /[\"']/.test(x);";
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('does NOT mistake division for a regex literal', () => {
            const existingCode = 'const avg = total / n;';
            const improvedCode = 'const avg = total / count;';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // A single well-formed triple-quote with no embedded bare quote is
        // ALSO protected by the plain "..." branch as an accident of how
        // greedy pairing partitions 3 consecutive quote chars into an empty
        // match + the real content + another empty match — so that shape
        // does not actually discriminate triple-quote-aware handling from
        // its absence. An embedded bare quote does: greedy double-quote-only
        // pairing closes early AT that embedded quote, leaving what follows
        // it (here, an unbalanced "(") unprotected structural code.
        it('does NOT flag an unbalanced bracket sitting after a bare quote embedded inside a Python triple-quoted string', () => {
            const existingCode = 'x = 1';
            const improvedCode = 'x = """He said "hi (there" to me"""';
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

        // Found probing realistic/messy LLM output shapes: a model that
        // echoes back a unified-diff hunk instead of plain replacement code.
        // Well-formed text (balanced brackets, real code tokens) that sails
        // past every other check here, but inserting it verbatim puts diff
        // markers into the source file — not a valid fix in any language.
        it('flags a unified-diff hunk as truncated, not a plain code fix', () => {
            const existingCode = 'const x = 1;';
            const improvedCode = '-const x = 1;\n+const x = 2;';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('does NOT flag a single-line fix that starts with "-" (ordinary negation)', () => {
            const existingCode = 'const x = compute();';
            const improvedCode = '-compute();';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Found probing realistic/messy LLM output shapes: the fix's own
        // position in an explanatory numbered list leaking into
        // improvedCode instead of staying in suggestionContent.
        it('flags a leading numbered-list marker as truncated', () => {
            const existingCode = 'const x = 1;';
            const improvedCode = '1. const x = 2;';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('flags a leading ")"-style list marker as truncated', () => {
            const existingCode = 'doWork();';
            const improvedCode = '2) doWork();';
            expect(checkFix(existingCode, improvedCode)).toBe('truncated');
        });

        it('does NOT mistake a decimal literal for a list marker', () => {
            const existingCode = 'const x = 1;';
            const improvedCode = 'const x = 1.5 * factor;';
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

    });
});
