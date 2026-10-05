import { ResolutionFixture } from './fixture.types';

type FixtureFile = Omit<ResolutionFixture, 'repository' | 'pullRequest'> & {
    repository?: Partial<ResolutionFixture['repository']>;
    pullRequest: Partial<ResolutionFixture['pullRequest']> &
        Pick<ResolutionFixture['pullRequest'], 'title' | 'body'>;
};

/** The repository and diff most cases share; a fixture states only what differs. */
const DEFAULT_REPOSITORY = {
    id: 'repo-recipes',
    name: 'recipes-web',
    owner: 'acme',
};
const DEFAULT_PULL_REQUEST = {
    number: 71,
    branch: 'feat/scale-servings',
    files: [
        {
            filename: 'src/servings/scale.ts',
            patch: "@@ -1,3 +1,9 @@\n+export function scaleServings(recipe, servings) {\n+  if (servings < 1) throw new RangeError('servings must be >= 1');\n+  const factor = servings / recipe.servings;\n+  return { ...recipe, servings, ingredients: recipe.ingredients.map(i => ({ ...i, amount: round(i.amount * factor) })) };\n+}\n",
        },
    ],
};

export function withDefaults(file: FixtureFile): ResolutionFixture {
    return {
        ...file,
        repository: { ...DEFAULT_REPOSITORY, ...file.repository },
        pullRequest: { ...DEFAULT_PULL_REQUEST, ...file.pullRequest },
    };
}
