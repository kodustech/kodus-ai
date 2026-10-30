/**
 * `full-file` retrieval across languages (issue #1826).
 *
 * The product is language-agnostic and this retriever is not, structurally: over
 * the context budget it narrows to the scope AROUND a hunk, and "where does the
 * enclosing scope start" is answered by DEFINITION_PATTERN, which recognises
 * some languages and not others. A corpus of TypeScript fixtures would have
 * proven nothing about the customer whose repository is Ruby, Go or Terraform.
 *
 * Two behaviours are pinned here, and they are deliberately different:
 *
 *   recognised language  -> the slice STARTS at the definition line, so a rule
 *                           about a whole function sees the whole function.
 *   unrecognised         -> a bounded window around the hunk (KRC-27). An
 *                           honest window beats a confident wrong "scope": the
 *                           point is that nothing is silently mis-sliced, and
 *                           that no language is refused outright.
 *
 * Under the budget every language gets the file whole, so the only thing that
 * can vary by language is the narrowing — which is what this file exercises.
 */
import { retrieveForShard } from './rule-context.retriever';
import type { RepoLookup } from './repo-lookup';
import {
    IKodyRule,
    KodyRuleContextNeed,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/** Budget small enough to force narrowing on every fixture below. */
const TINY_BUDGET = 400;

const lookupOver = (content: string): RepoLookup =>
    ({
        available: true,
        unavailableReason: '',
        stats: { grep: 0, read: 0, exists: 0, failures: 0 },
        grep: async () => '',
        read: async () => content,
        exists: async () => false,
        probe: async () => undefined,
    }) as unknown as RepoLookup;

const fullFileRule = {
    uuid: 'r1',
    rule: 'a function must not exceed 40 lines',
    contextNeed: {
        need: 'full-file' as KodyRuleContextNeed,
        sourceHash: 'h',
        source: 'author' as const,
        inferredAt: new Date(),
    },
} as Partial<IKodyRule>;

/**
 * A file shaped so the enclosing-scope search is the ONLY thing that can put the
 * definition on the page.
 *
 * `LEAD` unrelated lines come first, THEN the definition, then the body, and the
 * hunk lands near the end of the body. LEAD is chosen so that a naive
 * `start - ENCLOSING_LOOKBACK_LINES` window opens INSIDE the lead — well after
 * line 1 and before the definition. So the assertion "the slice starts at the
 * definition" fails unless the code really walked back and found it.
 *
 * The first version of this file put the definition on line 1, where the
 * lookback reached it anyway: every assertion passed with the search deleted.
 * A test that cannot fail is worse than no test, because it reports coverage
 * that is not there.
 */
const LEAD = 100; // unrelated lines before the definition
const BODY = 60; // lines of function body after it

function fixture(defLine: string, filler: string, body = BODY) {
    const lead = Array.from({ length: LEAD }, (_, i) => `${filler}lead${i}`);
    const bodyLines = Array.from({ length: body }, (_, i) => `${filler}${i}`);
    const lines = [...lead, defLine, ...bodyLines];
    // 1-based line of the last body line: LEAD + 1 (def) + body
    const hunkAt = LEAD + body;
    return {
        defAtLine: LEAD + 1,
        content: lines.join('\n') + '\n',
        file: {
            filename: 'PLACEHOLDER',
            patch: `@@ -${hunkAt},1 +${hunkAt},2 @@\n ${filler}0\n+${filler}new\n`,
        } as any,
    };
}

const CASES: Array<[string, string, string, string]> = [
    // [label, filename, the line that opens the scope, an indented body line]
    //
    // The point of this list is that NOTHING in the product knows it. Scope is
    // resolved by indentation, so a language is served because it indents, not
    // because someone added it here. Half of these were never enumerated
    // anywhere in the codebase.
    ['python', 'app/report.py', 'def build_monthly_report(orders):', '    total = 0  # '],
    ['ruby', 'app/report.rb', 'def build_monthly_report(orders)', '  total = 0 # '],
    ['go', 'internal/report.go', 'func BuildMonthlyReport(o []Order) string {', '\tvar total int // '],
    ['java', 'src/Report.java', 'public String buildMonthlyReport(List<Order> o) {', '    int total = 0; // '],
    ['php', 'src/Report.php', 'function buildMonthlyReport(array $orders) {', '    $total = 0; // '],
    ['csharp', 'src/Report.cs', 'public string BuildMonthlyReport(List<Order> o) {', '    var total = 0; // '],
    ['kotlin', 'src/Report.kt', 'fun buildMonthlyReport(orders: List<Order>): String {', '    var total = 0 // '],
    ['rust', 'src/report.rs', 'fn build_monthly_report(o: Vec<Order>) -> String {', '    let total = 0; // '],
    // ── never enumerated anywhere: these are the real test ──────────────
    ['elixir', 'lib/report.ex', 'def build_monthly_report(orders) do', '    total = 0 # '],
    ['erlang', 'src/report.erl', 'build_monthly_report(Orders) ->', '    Total = 0, % '],
    ['clojure', 'src/report.clj', '(defn build-monthly-report [orders]', '  (def total 0) ; '],
    ['haskell', 'src/Report.hs', 'buildMonthlyReport orders =', '    let total = 0 -- '],
    ['elm', 'src/Report.elm', 'buildMonthlyReport orders =', '    let total = 0 -- '],
    ['lua', 'src/report.lua', 'function build_monthly_report(orders)', '  local total = 0 -- '],
    ['perl', 'lib/Report.pm', 'sub build_monthly_report {', '    my $total = 0; # '],
    ['r', 'R/report.R', 'build_monthly_report <- function(orders) {', '  total <- 0 # '],
    ['julia', 'src/report.jl', 'function build_monthly_report(orders)', '    total = 0 # '],
    ['zig', 'src/report.zig', 'pub fn buildMonthlyReport(o: []Order) []u8 {', '    var total = 0; // '],
    ['dart', 'lib/report.dart', 'String buildMonthlyReport(List<Order> o) {', '  var total = 0; // '],
    ['swift', 'Sources/Report.swift', 'func buildMonthlyReport(_ o: [Order]) -> String {', '    var total = 0 // '],
    ['scala', 'src/Report.scala', 'def buildMonthlyReport(o: List[Order]): String = {', '  val total = 0 // '],
    ['groovy', 'src/Report.groovy', 'String buildMonthlyReport(List orders) {', '    def total = 0 // '],
    ['solidity', 'contracts/Report.sol', 'function buildMonthlyReport() public view returns (uint) {', '    uint total = 0; // '],
    ['vhdl', 'rtl/report.vhd', 'process (clk) is', '    variable total : integer; -- '],
    // ── not code at all ─────────────────────────────────────────────────
    ['yaml', 'ci/pipeline.yml', 'build_monthly_report:', '  script: echo # '],
    ['hcl', 'infra/main.tf', 'resource "aws_s3_bucket" "reports" {', '  tags = {} # '],
    ['scss', 'app/styles/_card.scss', '.card {', '  padding: 0px; // '],
    ['sql', 'db/report.sql', 'CREATE PROCEDURE monthly() BEGIN', '  DECLARE total INT; -- '],
];

describe('full-file retrieval is language-agnostic', () => {
    describe.each(CASES)(
        'over budget, %s narrows to the enclosing definition',
        (_label, filename, defLine, filler) => {
            it('starts the slice at the definition, not at an arbitrary offset', async () => {
                const { content, file } = fixture(defLine, filler);
                const res = await retrieveForShard({
                    file: { ...file, filename },
                    rules: [fullFileRule],
                    lookup: lookupOver(content),
                    budgetChars: TINY_BUDGET,
                });

                expect(res.unmet).toHaveLength(0);
                expect(res.slices).toHaveLength(1);
                const slice = res.slices[0];
                expect(slice.kind).toBe('full-file');
                expect(slice.truncated).toBe(true);
                // The whole point: the signature is on the page, so a rule
                // about the function as a unit can actually be applied.
                expect(slice.content.split('\n')[0]).toBe(defLine);
            });
        },
    );

    // The honest fallback. Nothing shallower to anchor on means no scope,
    // and the caller must say "window" rather than claim one.
    it('reports a WINDOW when the change is already at top level', async () => {
        const lines = Array.from({ length: 200 }, (_, i) => `top_level_${i} = ${i}`);
        const res = await retrieveForShard({
            file: {
                filename: 'config/settings.py',
                patch: `@@ -150,1 +150,2 @@\n top_level_0 = 0\n+top_level_new = 1\n`,
            } as any,
            rules: [fullFileRule],
            lookup: lookupOver(lines.join('\n') + '\n'),
            budgetChars: TINY_BUDGET,
        });

        expect(res.slices[0].label).toContain('a window around one hunk');
        expect(res.slices[0].label).not.toContain('the scope enclosing');
    });

    it('reports a WINDOW for a file with no indentation at all (minified)', async () => {
        const lines = Array.from({ length: 200 }, (_, i) => `var a${i}=${i};`);
        const res = await retrieveForShard({
            file: {
                filename: 'dist/bundle.min.js',
                patch: `@@ -150,1 +150,2 @@\n var a0=0;\n+var aNew=1;\n`,
            } as any,
            rules: [fullFileRule],
            lookup: lookupOver(lines.join('\n') + '\n'),
            budgetChars: TINY_BUDGET,
        });

        expect(res.slices[0].label).toContain('a window around one hunk');
    });

    // A file with no extension at all — Rakefile, Gemfile, Dockerfile, Makefile.
    it('serves an extensionless file with a window instead of skipping it', async () => {
        const { content, file } = fixture('task :report do', '  puts 1 # ');
        const res = await retrieveForShard({
            file: { ...file, filename: 'Rakefile' },
            rules: [fullFileRule],
            lookup: lookupOver(content),
            budgetChars: TINY_BUDGET,
        });

        expect(res.unmet).toHaveLength(0);
        expect(res.slices[0].content.length).toBeGreaterThan(0);
    });

    it('under budget every language gets the file whole, untruncated', async () => {
        for (const [, filename, defLine, filler] of CASES) {
            const { content, file } = fixture(defLine, filler, 2);
            const res = await retrieveForShard({
                file: { ...file, filename },
                rules: [fullFileRule],
                lookup: lookupOver(content),
                budgetChars: 100_000,
            });
            expect(res.slices[0].truncated).toBe(false);
            expect(res.slices[0].content).toBe(content);
        }
    });
});
