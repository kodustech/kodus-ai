export const prompt_getProductionReleases = (payload: string) => {
    return `Identify which releases are for production for each repository I provide. Return a JSON in the following format:

    "repos": [{
     "repo": "string",
    "productionReleases": boolean
    }]

    Production releases may be referenced as main, prod, production, release, etc.

    If there are no workflows you consider production releases, return an empty array.


    Input data:
    ${payload}`;
};
