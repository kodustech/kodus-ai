import { faker } from '@faker-js/faker';

const ORGANIZATION_AND_TEAM_DATA = {
    teamId: '9e4561d1-8374-4fa3-b384-637af67b2835',
    organizationId: '700ec9cc-da78-4772-8404-d2bda46d6277',
};

const ORGANIZATION_ID = '700ec9cc-da78-4772-8404-d2bda46d6277';

const PROJECT_ID = '10013';

const INTEGRATION = {
    authIntegration: {
        uuid: faker.string.uuid(),
        authDetails: {
            cloudId: 'CLOUD_ID',
            platform: 'JIRA',
            authToken: 'AUTH_TOKEN',
            expiresIn: 3600,
            refreshToken: 'REFRESH_TOKEN',
        },
    },
};

const INTEGRATION_CONFIG = [
    {
        id: '10046',
        name: 'Selected for Development',
        order: null,
        column: 'todo',
    },
    {
        id: '10050',
        name: 'In Development',
        order: 1,
        column: 'wip',
    },
    {
        id: '10051',
        name: 'Ready for QA',
        order: 2,
        column: 'wip',
    },
    {
        id: '10052',
        name: 'In QA',
        order: 3,
        column: 'wip',
    },
    {
        id: '10053',
        name: 'Ready for Homologation',
        order: 4,
        column: 'wip',
    },
    {
        id: '10054',
        name: 'In Homologation',
        order: 5,
        column: 'wip',
    },
    {
        id: '10055',
        name: 'Ready for Deploy',
        order: 6,
        column: 'wip',
    },
    {
        id: '10005',
        name: 'Done',
        order: null,
        column: 'done',
    },
];

const WORK_ITEM_TYPES = [
    {
        id: '10000',
        name: 'Epic',
        description: '',
        subtask: false,
    },
    {
        id: '10004',
        name: 'Story',
        description: '',
        subtask: false,
    },
    {
        id: '10018',
        name: 'Engineering Task',
        description: '',
        subtask: false,
    },
    {
        id: '10007',
        name: 'Bug',
        description: '',
        subtask: false,
    },
    {
        id: '10012',
        name: 'Critical Bug',
        description: '',
        subtask: false,
    },
    {
        id: '10020',
        name: 'Improvement',
        description: '',
        subtask: false,
    },
];

const WORK_ITEM_TYPES_DESCRIPTION_QUALITY = [
    {
        id: '10004',
        name: 'Story',
    },
    {
        id: '10018',
        name: 'Engineering Task',
    },
    {
        id: '10020',
        name: 'Improvement',
    },
];

const WORK_ITEM_TYPES_BUGS = [
    {
        id: '10007',
        name: 'Bug',
    },
    {
        id: '10012',
        name: 'Critical Bug',
    },
];

const mockedParameters = {
    ORGANIZATION_AND_TEAM_DATA,
    ORGANIZATION_ID,
    PROJECT_ID,
    INTEGRATION,
    INTEGRATION_CONFIG,
    WORK_ITEM_TYPES,
    WORK_ITEM_TYPES_DESCRIPTION_QUALITY,
    WORK_ITEM_TYPES_BUGS,
};

export default mockedParameters;
