import { ISprint } from '@/core/domain/platformIntegrations/interfaces/jiraSprint.interface';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { COMPILE_STATE } from '@/core/domain/sprint/enum/compileState.enum';
import { SPRINT_STATE } from '@/core/domain/sprint/enum/sprintState.enum';

const allSprints = (): Array<ISprint> => {
    return [
        {
            name: 'Sprint 1',
            state: SPRINT_STATE.CLOSED,
            startDate: new Date('2024-03-25'),
            endDate: new Date('2024-04-08'),
            id: '1',
        },
        {
            name: 'Sprint 2',
            state: SPRINT_STATE.ACTIVE,
            startDate: new Date('2024-04-09'),
            endDate: new Date('2024-04-23'),
            id: '2',
        },
    ];
};

const currentSprint = (): ISprint => {
    return {
        name: 'Sprint 2',
        state: SPRINT_STATE.ACTIVE,
        startDate: new Date('2024-04-09'),
        endDate: new Date('2024-04-23'),
        id: '2',
    };
};

const workItemsForCurrentSprint = (): Item[] => {
    return [
        {
            id: '10413',
            key: 'GE-31',
            name: 'Erro no cálculo de taxas de serviço',
            changelog: [],
            workItemCreatedAt: '2024-04-04T12:30:22.456-0300',
            created: '2024-04-04T12:30:22.456-0300',
            columnName: 'Done',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5b8e45a9d123af0098ef4562',
                userName: 'Clara Machado',
                userEmail: 'clara.machado@kodus.io',
            },
            workItemType: {
                name: 'Bug',
                id: '10007',
                description: 'A problem or error.',
                subtask: false,
            },
            status: {
                name: 'Done',
                id: '10005',
                statusCategory: {
                    name: 'Done',
                    id: 3,
                },
            },
        },
        {
            id: '10414',
            key: 'GE-32',
            name: 'Falha ao exportar dados em CSV',
            changelog: [],
            workItemCreatedAt: '2024-04-05T16:12:47.392-0300',
            created: '2024-04-05T16:12:47.392-0300',
            columnName: 'Done',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5acdfe3ab82aef2291f21234',
                userName: 'Marcos Teixeira',
                userEmail: 'marcos.teixeira@kodus.io',
            },
            workItemType: {
                name: 'Bug',
                id: '10007',
                description: 'A problem or error.',
                subtask: false,
            },
            status: {
                name: 'Done',
                id: '10005',
                statusCategory: {
                    name: 'Done',
                    id: 3,
                },
            },
        },
        {
            id: '10415',
            key: 'GE-33',
            name: 'Interface congela ao modificar configurações',
            changelog: [],
            workItemCreatedAt: '2024-04-06T13:58:09.580-0300',
            created: '2024-04-06T13:58:09.580-0300',
            columnName: 'Done',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5a9e6f240c0b25513988541b',
                userName: 'Luisa Barros',
                userEmail: 'luisa.barros@kodus.io',
            },
            workItemType: {
                name: 'Bug',
                id: '10007',
                description: 'A problem or error.',
                subtask: false,
            },
            status: {
                name: 'Done',
                id: '10005',
                statusCategory: {
                    name: 'Done',
                    id: 3,
                },
            },
        },
        {
            id: '20401',
            key: 'GE-34',
            name: 'Revisar documentação do API',
            changelog: [],
            workItemCreatedAt: '2024-04-04T08:20:00.123-0300',
            created: '2024-04-04T08:20:00.123-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5b8e45a9d123af0098ef4562',
                userName: 'Clara Machado',
                userEmail: 'clara.machado@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20402',
            key: 'GE-35',
            name: 'Atualizar servidores de teste',
            changelog: [],
            workItemCreatedAt: '2024-04-04T09:00:10.456-0300',
            created: '2024-04-04T09:00:10.456-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5acdfe3ab82aef2291f21234',
                userName: 'Marcos Teixeira',
                userEmail: 'marcos.teixeira@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20403',
            key: 'GE-36',
            name: 'Preparar relatório de desempenho',
            changelog: [],
            workItemCreatedAt: '2024-04-04T10:15:22.789-0300',
            created: '2024-04-04T10:15:22.789-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5a9e6f240c0b25513988541b',
                userName: 'Luisa Barros',
                userEmail: 'luisa.barros@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20404',
            key: 'GE-37',
            name: 'Testar nova interface do usuário',
            changelog: [],
            workItemCreatedAt: '2024-04-04T11:30:33.250-0300',
            created: '2024-04-04T11:30:33.250-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5b8e45a9d123af0098ef4562',
                userName: 'Clara Machado',
                userEmail: 'clara.machado@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20405',
            key: 'GE-38',
            name: 'Organizar reunião de sprint',
            changelog: [],
            workItemCreatedAt: '2024-04-05T12:45:50.123-0300',
            created: '2024-04-05T12:45:50.123-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5acdfe3ab82aef2291f21234',
                userName: 'Marcos Teixeira',
                userEmail: 'marcos.teixeira@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20406',
            key: 'GE-39',
            name: 'Atualizar documentação de código',
            changelog: [],
            workItemCreatedAt: '2024-04-06T14:00:01.456-0300',
            created: '2024-04-06T14:00:01.456-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5a9e6f240c0b25513988541b',
                userName: 'Luisa Barros',
                userEmail: 'luisa.barros@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20407',
            key: 'GE-40',
            name: 'Design de novo logo para o projeto',
            changelog: [],
            workItemCreatedAt: '2024-04-07T09:20:22.789-0300',
            created: '2024-04-07T09:20:22.789-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5b8e45a9d123af0098ef4562',
                userName: 'Clara Machado',
                userEmail: 'clara.machado@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20408',
            key: 'GE-41',
            name: 'Corrigir erros de digitação na interface',
            changelog: [],
            workItemCreatedAt: '2024-04-07T10:35:47.392-0300',
            created: '2024-04-07T10:35:47.392-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5acdfe3ab82aef2291f21234',
                userName: 'Marcos Teixeira',
                userEmail: 'marcos.teixeira@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20409',
            key: 'GE-42',
            name: 'Preparar apresentação para clientes',
            changelog: [],
            workItemCreatedAt: '2024-04-07T11:50:59.580-0300',
            created: '2024-04-07T11:50:59.580-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5a9e6f240c0b25513988541b',
                userName: 'Luisa Barros',
                userEmail: 'luisa.barros@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '10416',
            key: 'GE-43',
            name: 'Problema de sincronização com calendário Outlook',
            changelog: [],
            workItemCreatedAt: '2024-04-10T08:15:30.123-0300',
            created: '2024-04-10T08:15:30.123-0300',
            columnName: 'Done',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5acdfe3ab82aef2291f21234',
                userName: 'Marcos Teixeira',
                userEmail: 'marcos.teixeira@kodus.io',
            },
            workItemType: {
                name: 'Bug',
                id: '10007',
                description: 'A problem or error.',
                subtask: false,
            },
            status: {
                name: 'Done',
                id: '10005',
                statusCategory: {
                    name: 'Done',
                    id: 3,
                },
            },
        },
        {
            id: '10417',
            key: 'GE-44',
            name: 'Erro de visualização de PDF no navegador',
            changelog: [],
            workItemCreatedAt: '2024-04-10T09:45:47.456-0300',
            created: '2024-04-10T09:45:47.456-0300',
            columnName: 'Done',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5a9e6f240c0b25513988541b',
                userName: 'Luisa Barros',
                userEmail: 'luisa.barros@kodus.io',
            },
            workItemType: {
                name: 'Bug',
                id: '10007',
                description: 'A problem or error.',
                subtask: false,
            },
            status: {
                name: 'Done',
                id: '10005',
                statusCategory: {
                    name: 'Done',
                    id: 3,
                },
            },
        },
        {
            id: '20410',
            key: 'GE-45',
            name: 'Optimização de query SQL para relatórios',
            changelog: [],
            workItemCreatedAt: '2024-04-10T10:30:22.789-0300',
            created: '2024-04-10T10:30:22.789-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5b8e45a9d123af0098ef4562',
                userName: 'Clara Machado',
                userEmail: 'clara.machado@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20411',
            key: 'GE-46',
            name: 'Revisão de usabilidade do módulo de configurações',
            changelog: [],
            workItemCreatedAt: '2024-04-10T11:20:33.250-0300',
            created: '2024-04-10T11:20:33.250-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5acdfe3ab82aef2291f21234',
                userName: 'Marcos Teixeira',
                userEmail: 'marcos.teixeira@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '20412',
            key: 'GE-47',
            name: 'Atualização de segurança para o servidor de emails',
            changelog: [],
            workItemCreatedAt: '2024-04-10T12:00:10.456-0300',
            created: '2024-04-10T12:00:10.456-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5a9e6f240c0b25513988541b',
                userName: 'Luisa Barros',
                userEmail: 'luisa.barros@kodus.io',
            },
            workItemType: {
                name: 'Task',
                id: '10005',
                description: 'A small, distinct piece of work.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
        {
            id: '30401',
            key: 'GE-50',
            name: 'Implementação do Sistema de Autenticação',
            changelog: [],
            workItemCreatedAt: '2024-04-12T09:00:00.123-0300',
            created: '2024-04-12T09:00:00.123-0300',
            columnName: 'In Progress',
            description: {
                content: [],
            },
            assignee: {
                accountId: '5b8e45a9d123af0098ef4562',
                userName: 'Clara Machado',
                userEmail: 'clara.machado@kodus.io',
            },
            workItemType: {
                name: 'Epic',
                id: '10008',
                description:
                    'A large body of work that encompasses many issues, needs a plan, and is delivered over a set period of time.',
                subtask: false,
            },
            status: {
                name: 'In Progress',
                id: '10006',
                statusCategory: {
                    name: 'In Progress',
                    id: 2,
                },
            },
        },
    ];
};

export { allSprints, currentSprint, workItemsForCurrentSprint };
