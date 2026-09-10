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

        // Kody's own review caught this: the noop comparison ran before the
        // scaffolding-label strip, so a label glued onto otherwise-identical
        // code was not recognized as a noop.
        it('flags a scaffolding-label-prefixed noop ("Fix: <identical code>")', () => {
            const existingCode = 'return x;';
            const improvedCode = 'Fix: return x;';
            expect(checkFix(existingCode, improvedCode)).toBe('noop-fix');
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

        // Regression guard: these words were proposed as
        // STRONG_CODE_TOKEN_RE additions and deliberately rejected — they
        // are common enough in plain English that adding them would let
        // real prose slip through as if it were a valid fix, which is the
        // harm on the OTHER side of this check.
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

        // Found probing realistic/messy LLM output shapes, not hand-picked
        // to fit the implementation: a scaffolding-style label ("Fix:",
        // "**WHY:**") leaking into improvedCode has a bare ":" that used to
        // satisfy CODE_TOKEN_RE all by itself. Same leak
        // strip-review-scaffolding.ts documents for suggestionContent.
        it.each([
            '**Fix:** add a null check before line 5',
            'Note: this needs a null check',
            'WHY: the null check was missing',
            'Suggestion: add error handling here',
        ])('flags a scaffolding-label lead-in %j as prose, not code', (improvedCode) => {
            const existingCode = 'const x = 1;';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        it('does NOT strip a genuine "key: value" pair — only the known label vocabulary', () => {
            const existingCode = 'const config = { timeout: 30 };';
            const improvedCode = 'timeout: 60';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Kody's own review of this file caught these: a bare ":" or a
        // WEAK-only keyword (import/async/await/yield) is not enough on its
        // own once real English stop words surround it — a colon or "await"
        // used as an ordinary sentence word, not a code construct.
        it.each([
            'Add a null check: verify the input before using it',
            'await the response before continuing',
            'this could yield unexpected results for the user',
            'we should import the missing validation logic here',
        ])('flags a sentence containing a WEAK-only signal (%j) as prose', (improvedCode) => {
            const existingCode = 'if (user.role === "admin") grantAccess();';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        it('still accepts short, genuinely code-shaped WEAK-only fixes', () => {
            expect(checkFix('timeout: 30', 'timeout: 60')).toBeNull();
            expect(checkFix('import sys', 'import os')).toBeNull();
            expect(checkFix('yield old_item', 'yield next_item')).toBeNull();
        });

        it('flags a scaffolding-label lead-in even with whitespace before the colon', () => {
            const existingCode = 'const x = 1;';
            const improvedCode = 'Fix : add a null check';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        it('does NOT misread a genuine code field whose name is also a label word ("how")', () => {
            // "how" is in PROSE_LABEL_LEAD_RE's vocabulary, but stripping it
            // here would leave the bare value "number" with no code
            // signal — the fallback-to-unstripped path must catch this.
            const existingCode = 'interface Options { how: string }';
            const improvedCode = 'how: number';
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Kody's own review caught this: the fallback-to-unstripped path
        // above (for "how: number") also let a MULTI-WORD label-prefixed
        // sentence through, since the unstripped view's colon alone
        // satisfied isCodeLike — "Fix: validate inputs" shipped the label
        // text verbatim as if it were code. A real value is essentially
        // never 2+ bare words with nothing else, so the fallback is now
        // restricted to a single-token remainder.
        it.each([
            'Fix: validate inputs',
            'Solution: refactor service',
            'Note: this needs better error handling',
        ])('flags a label-prefixed multi-word sentence (%j) as prose, not code', (improvedCode) => {
            const existingCode = 'const x = 1;';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });

        // Kody's own review caught this too: an ordinary object/config key
        // that is ALSO an English stop word ("on", "check", "in") made
        // isCodeLike suppress a genuine tight key:value pair.
        it.each([
            ['const config = { check: false };', 'check: true'],
            ['const config = { on: false };', 'on: true'],
            ['const config = { in: 3 };', 'in: 5'],
        ])('does NOT flag a tight key:value pair whose key is a stop word (%j -> %j)', (existingCode, improvedCode) => {
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        // Kody's own review caught this: TIGHT_KEY_VALUE_RE bypassed the
        // stopword gate for the WHOLE pair, not just the key — "Note: this"
        // and "Fix: it" match the exact same tight shape and shipped as
        // code. The gate now only exempts the key; the value is still
        // checked.
        it.each(['Note: this', 'Fix: it', 'Solution: add'])(
            'flags a label-prefixed tight pair (%j) as prose, not code',
            (improvedCode) => {
                expect(checkFix('const x = 1;', improvedCode)).toBe('prose-only');
            },
        );

        // Round 5 tried gating on the KEY instead (reject only when the key
        // is ALSO a known label word), to keep "enabled: on"/"action: add"
        // as code. That opened a bigger hole than it closed: any label a
        // model emits outside the ~15-word vocabulary ("Warning:",
        // "Example:", "Consider:") bypassed the value check entirely and
        // shipped as code — there is no regex shape that tells "enabled"
        // apart from "warning", both are just a lowercase word.
        it.each([
            'Warning: it',
            'Example: this',
            'Consider: add',
        ])('flags a label-prefixed tight pair using a label OUTSIDE the known vocabulary (%j) as prose', (improvedCode) => {
            expect(checkFix('const x = 1;', improvedCode)).toBe('prose-only');
        });

        // The real fix for "enabled: on"/"action: add": existingCode is
        // guaranteed real source text (never prose), so the SAME key
        // already appearing there in a "key: value" shape is proof, not a
        // vocabulary guess.
        it.each([
            ['const c = { enabled: false };', 'enabled: on'],
            ['const c = { action: "" };', 'action: add'],
            ['logging: off', 'logging: on'],
            ['mode: off', 'mode: on'],
        ])('accepts a stop-word-valued tight pair when existingCode proves the key is a real field (%j -> %j)', (existingCode, improvedCode) => {
            expect(checkFix(existingCode, improvedCode)).toBeNull();
        });

        it('still flags the same tight pair as prose when existingCode does NOT show the key', () => {
            // Same shape as the accepted cases above, but nothing in
            // existingCode proves "enabled" is a real field here — no
            // evidence, no exemption.
            expect(checkFix('const x = 1;', 'enabled: on')).toBe('prose-only');
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

        it('still flags "break" embedded in an ordinary English sentence as prose', () => {
            const existingCode = 'do_something()';
            const improvedCode = 'this would break the existing tests';
            expect(checkFix(existingCode, improvedCode)).toBe('prose-only');
        });
    });
});
