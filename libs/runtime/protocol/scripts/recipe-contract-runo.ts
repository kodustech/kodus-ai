// ENV-08, Runo's side: runs every recipe in fixtures/recipes/verdicts.json
// through Runo's parseRecipe and checks its verdict. Runo is another
// repository (github.com/kodustech/runo) and runs on Bun, so this is a
// script, not a jest test:
//   bun libs/runtime/protocol/scripts/recipe-contract-runo.ts <runo checkout>
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runo = process.argv[2];
if (!runo) {
    console.error('usage: bun recipe-contract-runo.ts <runo checkout>');
    process.exit(2);
}
const root = resolve(__dirname, '../../../..');
const fixtures = join(root, 'libs/runtime/protocol/fixtures/recipes');
const { recipes } = JSON.parse(readFileSync(join(fixtures, 'verdicts.json'), 'utf8')) as { recipes: Record<string, { runo: string }> };

async function main() {
    const { parseRecipe } = (await import(resolve(runo, 'src/recipe.ts'))) as { parseRecipe: (text: string, source: string) => unknown };
    const wrong: string[] = [];
    for (const [path, v] of Object.entries(recipes)) {
        let error: string | undefined;
        try {
            parseRecipe(readFileSync(join(root, path), 'utf8'), path);
        } catch (e) {
            error = String((e as Error).message ?? e);
        }
        const ok = v.runo === 'accept' ? error === undefined : error !== undefined && error.includes(v.runo.replace(/^refuse: /, ''));
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${path}: want ${v.runo}${ok ? '' : `, got ${error ?? 'accept'}`}`);
        if (!ok) wrong.push(path);
    }
    console.log(`${Object.keys(recipes).length - wrong.length}/${Object.keys(recipes).length} match Runo`);
    process.exit(wrong.length ? 1 : 0);
}

void main();
