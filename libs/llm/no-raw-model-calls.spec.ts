/**
 * GOVERNANCE GUARDRAIL — "one door to the model".
 *
 * The whole BYOK/LLM consolidation exists so there is exactly ONE way to call a
 * model (`LLM.run`) and ONE way to assemble one (`resolveModelConfig`, internal
 * to `@libs/llm`). This test makes that structural, not aspirational: it FAILS
 * the moment a NEW source file outside the allowed layers calls the AI SDK
 * (`generateText`/`generateObject`/`streamText`) or a BYOK model builder
 * (`resolveModelConfig`/`buildModelFromSlot`/`wrapByokModel`) directly.
 *
 * Allowed layers:
 *   - `libs/llm/**`                              (the primitive + its internals)
 *   - `libs/agent-harness/infrastructure/ai-sdk/**` (the loop engine LLM.run drives)
 *
 * KNOWN, PRE-EXISTING callers are grandfathered in `ALLOWLIST` with a `// TODO
 * migrate` — shrink that list over time; never grow it. A new entry here should
 * be a deliberate, reviewed exception, not the default.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_LIBS = path.resolve(__dirname, '..');

// Raw AI SDK calls + BYOK model builders that belong ONLY behind the primitive.
const FORBIDDEN = [
    /\bgenerateText\s*\(/,
    /\bgenerateObject\s*\(/,
    /\bstreamText\s*\(/,
    /\bresolveModelConfig\s*\(/,
    /\bbuildModelFromSlot\s*\(/,
    /\bwrapByokModel\s*\(/,
];

// Files under an allowed layer never count.
const ALLOWED_DIR = (rel: string): boolean =>
    rel.startsWith('llm/') ||
    rel.startsWith('agent-harness/infrastructure/ai-sdk/');

// Pre-existing callers grandfathered here have all been migrated to LLM.run —
// the allowlist is EMPTY. Keep it empty: a new raw caller is a design regression,
// not a grandfathering candidate. Add an entry only as a deliberate, reviewed
// exception (with a `// TODO migrate`), never as the default.
const ALLOWLIST = new Set<string>([]);

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            walk(full, acc);
        } else if (
            entry.name.endsWith('.ts') &&
            !entry.name.endsWith('.spec.ts') &&
            !entry.name.endsWith('.d.ts')
        ) {
            acc.push(full);
        }
    }
    return acc;
}

describe('governance: one door to the model', () => {
    it('no NEW source file calls the AI SDK / BYOK builders outside the allowed layers', () => {
        const violations: string[] = [];
        for (const file of walk(REPO_LIBS)) {
            const rel = path.relative(REPO_LIBS, file).split(path.sep).join('/');
            if (ALLOWED_DIR(rel) || ALLOWLIST.has(rel)) continue;
            // Strip block + line comments so a doc reference to `generateText(`
            // is never a false positive — only real calls count.
            const src = fs
                .readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:])\/\/.*$/gm, '$1');
            if (FORBIDDEN.some((re) => re.test(src))) {
                violations.push(rel);
            }
        }
        expect(violations).toEqual([]);
    });
});
