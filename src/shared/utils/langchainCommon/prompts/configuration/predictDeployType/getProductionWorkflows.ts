export const prompt_getProductionWorkflows = (payload: string) => {
    return `Identify which deployments are for production for each repository I provide. Return a JSON in the following format:

    "repos": [{

     "repo": "string",

    "productionWorkflows": [{id: "", name: ""}]

    }]

    Production deployments may be referenced as main, prod, production, release, etc.

    If there are no workflows you consider production deployments, return an empty array.


    Input data:
    ${payload}`;
};
