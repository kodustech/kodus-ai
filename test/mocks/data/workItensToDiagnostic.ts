import { faker } from '@faker-js/faker';

const workItemsAll = (filter: { workItemName: string }): Array<any> => [
    {
        columnName: 'Ready To Do',
        workItems: [
            {
                id: '10240',
                key: 'KC-198',
                name: 'Insights: Limite de WIP considerando período errado para a análise',
                description: {
                    version: 1,
                    type: 'doc',
                    content: [
                        {
                            type: 'heading',
                            attrs: {
                                level: 2,
                            },
                            content: [
                                {
                                    type: 'emoji',
                                    attrs: {
                                        shortName: ':lady_beetle:',
                                        id: '1f41e',
                                        text: '🐞',
                                    },
                                },
                                {
                                    type: 'text',
                                    text: ' Descrição do Erro',
                                },
                            ],
                        },
                        {
                            type: 'paragraph',
                            content: [
                                {
                                    type: 'text',
                                    text: 'Hoje os Insights olham para as atividades dos últimos 3 meses do board do cliente, o que daria 12 semanas. Pelos dados do banco, aparentemente o código está analisando até 12 semanas, ou seja, se o board do cliente só existir há 2 meses, o código vai olhar para 8 semanas e registrar o número de atividades em WIP simultaneamente nessas 8 semanas - isso está correto. Porém, para o cálculo da média de semanas que o time respeitou o WIP, parece que está sempre usando fixo o número de ',
                                },
                                {
                                    type: 'text',
                                    text: '8 semanas.',
                                    marks: [
                                        {
                                            type: 'strong',
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'paragraph',
                            content: [
                                {
                                    type: 'text',
                                    text: 'Então para ficar claro, ',
                                },
                                {
                                    type: 'text',
                                    text: 'como deve funcionar',
                                    marks: [
                                        {
                                            type: 'strong',
                                        },
                                        {
                                            type: 'textColor',
                                            attrs: {
                                                color: '#36b37e',
                                            },
                                        },
                                    ],
                                },
                                {
                                    type: 'text',
                                    text: ':',
                                },
                            ],
                        },
                        {
                            type: 'bulletList',
                            content: [
                                {
                                    type: 'listItem',
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [
                                                {
                                                    type: 'text',
                                                    text: 'Os insights consideram 3 meses, o que equivale a 12 semanas. Então sempre vamos olhar todo o histórico do cliente até 12 semanas, se só tiver 10 semanas, vamos pegar o número de itens simultâneos em WIP dessas 10 semanas;',
                                                },
                                            ],
                                        },
                                    ],
                                },
                                {
                                    type: 'listItem',
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [
                                                {
                                                    type: 'text',
                                                    text: 'Depois para fazer o cálculo da média, temos que contar o número de elementos no array. Ou seja:',
                                                },
                                            ],
                                        },
                                        {
                                            type: 'bulletList',
                                            content: [
                                                {
                                                    type: 'listItem',
                                                    content: [
                                                        {
                                                            type: 'paragraph',
                                                            content: [
                                                                {
                                                                    type: 'text',
                                                                    text: 'Se tiver dados de 8 semanas, usamos o número 8 pra tirar a média;',
                                                                },
                                                            ],
                                                        },
                                                    ],
                                                },
                                                {
                                                    type: 'listItem',
                                                    content: [
                                                        {
                                                            type: 'paragraph',
                                                            content: [
                                                                {
                                                                    type: 'text',
                                                                    text: 'Se forem dados de 10 semanas, usamos 10;',
                                                                },
                                                            ],
                                                        },
                                                    ],
                                                },
                                                {
                                                    type: 'listItem',
                                                    content: [
                                                        {
                                                            type: 'paragraph',
                                                            content: [
                                                                {
                                                                    type: 'text',
                                                                    text: 'Se forem dados de 12 semanas, usamos 12;',
                                                                },
                                                            ],
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    ],
                                },
                                {
                                    type: 'listItem',
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [
                                                {
                                                    type: 'text',
                                                    text: 'Como eu mencionei, aparentemente o código está fazendo toda a parte de get e de contagem de itens corretamente. O que está errado é apenas o fator de divisão para chegar na média, que está sempre considerando 8, ao invés de ser dinâmico;',
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'panel',
                            attrs: {
                                panelType: 'warning',
                            },
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [
                                        {
                                            type: 'text',
                                            text: 'Se for necessário modificar uma parte do código que afete o dado de entrada de outras métricas, volte e alinhe comigo e Wellington sobre isso - pois se for uma parte sem teste, iremos analisar a criação do teste já em conjunto com o novo código.',
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'panel',
                            attrs: {
                                panelType: 'note',
                            },
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [
                                        {
                                            type: 'text',
                                            text: 'Além disso é necessário conferir no código como está sendo salva a contagem de semanas para colocar no resultado do array de avaliação do resultado. No array abaixo, pego direto do banco de dados, a contagem de semana começa em 1 e vai sequencial até 6, mas depois muda para 48, e segue sequencial até 52. O correto seria ir de 1 até 12 sequencialmente.',
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'codeBlock',
                            attrs: {},
                            content: [
                                {
                                    type: 'text',
                                    text: '{"message": "", "rawData": {"wipCounts": {"1": 14, "2": 17, "3": 21, "4": 16, "5": 18, "6": 3, "48": 11, "49": 20, "50": 19, "51": 11, "52": 6}, "weeksWithinWIP": 0}}',
                                },
                            ],
                        },
                    ],
                },
                changelog: [
                    {
                        id: '12284',
                        created: '2024-02-06T22:51:28.783-0300',
                        movements: [
                            {
                                field: 'Rank',
                                fromColumnId: '',
                                fromColumnName: '',
                                toColumnId: '',
                                toColumnName: 'Ranked lower',
                            },
                        ],
                    },
                    {
                        id: '12221',
                        created: '2024-02-05T19:16:04.662-0300',
                        movements: [
                            {
                                field: 'Rank',
                                fromColumnId: '',
                                fromColumnName: '',
                                toColumnId: '',
                                toColumnName: 'Ranked lower',
                            },
                        ],
                    },
                    {
                        id: '12220',
                        created: '2024-02-05T19:16:04.367-0300',
                        movements: [
                            {
                                field: 'status',
                                fromColumnId: '10011',
                                fromColumnName: 'In Refinement',
                                toColumnId: '10010',
                                toColumnName: 'Ready To Do',
                            },
                        ],
                    },
                    {
                        id: '12187',
                        created: '2024-02-05T15:14:33.600-0300',
                        movements: [
                            {
                                field: 'status',
                                fromColumnId: '10003',
                                fromColumnName: 'Backlog',
                                toColumnId: '10011',
                                toColumnName: 'In Refinement',
                            },
                        ],
                    },
                ],
                workItemCreatedAt: '2024-02-05T15:14:33.122-0300',
                columnName: 'Ready To Do',
                assignee: {},
                workItemType: {
                    name: filter.workItemName,
                    id: '10007',
                    description: 'Um problema ou erro.',
                    subtask: false,
                },
                status: {
                    name: 'Ready To Do',
                    id: '10010',
                    statusCategory: {
                        name: 'Itens Pendentes',
                        id: 2,
                    },
                },
            },
        ],
    },
];

const states = ['Backlog', 'In Progress', 'Review', 'Done'];
const transitions = {
    'Backlog': ['In Progress'],
    'In Progress': ['Review'],
    'Review': ['Done'],
    // Define more transitions as needed
};

const generateStatusTransition = (fromState) => {
    const possibleTransitions = transitions[fromState];
    const toState =
        possibleTransitions[
            faker.datatype.number({
                min: 0,
                max: possibleTransitions.length - 1,
            })
        ];
    return toState;
};

const generateChangelog = (currentState) => {
    let previousState = 'Backlog'; // Assuming all cards start in the Backlog
    const changelog = [];
    while (previousState !== currentState) {
        const nextState = generateStatusTransition(previousState);
        changelog.push({
            id: faker.datatype.uuid(),
            created: faker.date.recent().toISOString(),
            movements: [
                {
                    field: 'status',
                    fromColumnId: '',
                    fromColumnName: previousState,
                    toColumnId: '',
                    toColumnName: nextState,
                },
            ],
        });
        previousState = nextState;
    }
    return changelog;
};

const generateWorkItem = () => {
    const finalState =
        states[faker.datatype.number({ min: 0, max: states.length - 1 })];
    const changelog = generateChangelog(finalState);

    return {
        id: faker.datatype.uuid(),
        key: faker.random.alphaNumeric(6),
        name: faker.lorem.sentence(),
        description: {
            version: 1,
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: faker.lorem.paragraph() }],
                },
            ],
            // Add more content as needed
        },
        changelog: changelog,
        workItemCreatedAt: faker.date.past().toISOString(),
        columnName: finalState,
        assignee: {},
        workItemType: {
            name: 'Bug',
            id: faker.datatype.uuid(),
            description: 'A problem or error.',
            subtask: false,
        },
        status: {
            name: finalState,
            id: faker.datatype.number({ min: 10000, max: 99999 }),
            statusCategory: {
                name: 'Pending Items',
                id: 2,
            },
        },
    };
};

const generateData = (numItems = 5) => {
    return {
        columnName: 'Ready To Do',
        workItems: Array.from({ length: numItems }, generateWorkItem),
    };
};

export { workItemsAll, generateData, generateWorkItem };
