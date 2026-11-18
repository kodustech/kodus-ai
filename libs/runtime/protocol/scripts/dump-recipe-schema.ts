// Writes the recipe's JSON Schema (recipeJsonSchema) next to the protocol.
// Usage: node -r ts-node/register/transpile-only -r tsconfig-paths/register \
//   libs/runtime/protocol/scripts/dump-recipe-schema.ts [out.json]
import { writeFileSync } from 'node:fs';

import { recipeJsonSchema } from '../recipe';

const out = process.argv[2] ?? 'libs/runtime/protocol/recipe.schema.json';
writeFileSync(out, JSON.stringify(recipeJsonSchema(), null, 2) + '\n');
console.log(`wrote ${out}`);
