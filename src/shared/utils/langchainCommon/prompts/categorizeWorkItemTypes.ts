export const prompt_categorizeWorkItemTypes = (
    payload: any,
) => {
    return `{prompt_kodyContext}
    Sua missão é agrupar os tipos de work items de um time de engenharia de software em categorias.

    Tipos de itens já categorizados (Input JSON): ${JSON.stringify(payload?.typesOfWorkItemsAlreadyCategorized)}

    Tipos de itens a serem categorizados (Input JSON): ${JSON.stringify(payload?.workItemsTypesToCategorize)}

    Na hora de agrupar os tipos de work items, você pode usar as categorias já existentes do JSON "typesOfWorkItemsAlreadyCategorized" ou criar novas categorias.

    Seu objetivo é retornar um JSON com os TODOS os tipos de work items dos dois objetos de entraga, agrupados em categorias.

    O JSON de saída deve seguir o seguinte formato:
    \`\`\`
        { "categorizedWorkItemTypes": [
            {
                "category": "String",
                "workItemsTypes": [
                    {
                        "id": "String",
                        "name": "String"
                    }
                ]
            },
        ]}
    \`\`\``;
};
