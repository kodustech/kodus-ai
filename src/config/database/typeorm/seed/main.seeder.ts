import { DataSource } from 'typeorm';
import { Seeder, SeederFactoryManager } from 'typeorm-extension';
import { AutomationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/automation.model';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';

async function seedAutomation(dataSource: DataSource) {
    const anotherTableDataList = [
        {
            name: 'Optimization of Task Descriptions and Acceptance Criteria',
            description:
                'After creating an task, the assistant provides suggestions to improve clarity and detail, ensuring well-defined task descriptions and more efficient documentation.',
            tags: [
                'Ensure Best Practice',
                'Improve Productivity',
                'Mitigate Delivery Risks',
            ],
            antiPatterns: [
                'Issues without Clear Descriptions',
                'Issues without Acceptance Criteria Defined',
            ],
            status: true,
            automationType: AutomationType.AUTOMATION_ISSUES_DETAILS,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Creation of Detailed Tasks with Acceptance Criteria',
            description:
                'When starting a new task, the assistant helps you build the complete description of the task and its acceptance criteria from your briefing, maximizing the efficiency of this step.',
            tags: [
                'Ensure Best Practice',
                'Improve Productivity',
                'Mitigate Delivery Risks',
            ],
            antiPatterns: [
                'Issues without Clear Descriptions',
                'Issues without Acceptance Criteria Defined',
            ],
            status: true,
            automationType: AutomationType.AUTOMATION_IMPROVE_TASK,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Tracking of Progress and Delays in Activities',
            description:
                'The assistant monitors task progress. If an activity is taking longer than usual, notifications are sent to help the team in possible impediments, to encourage board updates and ease delay communication.',
            tags: [
                'Improve Productivity',
                'Improve Delivery Visibility',
                'Mitigate Delivery Risks',
            ],
            antiPatterns: [],
            status: true,
            automationType: AutomationType.AUTOMATION_INTERACTION_MONITOR,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Weekly Progress Report and Workflow Insights',
            description:
                'The assistant provides a weekly summary to the delivery leader, highlighting forecasts, risk points, and individual challenges. This summary helps in the management and strategic communication of activities.',
            tags: ['Improve Delivery Visibility', 'Mitigate Delivery Risks'],
            antiPatterns: [],
            status: true,
            automationType: AutomationType.AUTOMATION_TEAM_PROGRESS,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Ensure Tasks Have Assignees at the Beginning of WIP',
            description:
                'When an task moves to the WIP column, the assistant checks if it has an assignee. If none, a notification is sent to the team via Slack, encouraging them to assign the task so the board displays tasks accurately.',
            tags: ['Ensure Best Practice', 'Improve Delivery Visibility'],
            antiPatterns: ['Lack of defined WIP Limit'],
            status: false,
            automationType: AutomationType.AUTOMATION_ENSURE_ASSIGNEES,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Ensure Board Update through Commit Validation',
            description:
                'After every commit, the assistant checks whether the developer has an assigned task in progress. If not, it prompts the developer to specify the related task, ensuring board accuracy. This involves helping link and move the card if necessary.',
            tags: ['Ensure Best Practice', 'Improve Delivery Visibility'],
            antiPatterns: ['Commits not linked to an issue'],
            status: false,
            automationType: AutomationType.AUTOMATION_COMMIT_VALIDATION,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Monitoring and Warning of WIP limits',
            description:
                'Every day, the assistant monitors if active tasks exceed WIP limit. If so, it Slack notifies, highlighting the three oldest tasks. This helps the team handle overload and explore solutions like task redistribution.',
            tags: ['Ensure Best Practice', 'Mitigate Delivery Risks'],
            antiPatterns: ['Lack of defined WIP Limit'],
            status: false,
            automationType: AutomationType.AUTOMATION_WIP_LIMITS,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Identification and Warning of Constraints in Waiting Columns',
            description:
                'The assistant actively monitors the aging of cards in waiting columns on the board. When identifying prolonged waits, notifications are sent to speed up the flow and avoid possible constraints.',
            tags: ['Improve Delivery Visibility', 'Mitigate Delivery Risks'],
            antiPatterns: ['Lack of defined WIP Limit'],
            status: false,
            automationType: AutomationType.AUTOMATION_WAITING_CONSTRAINTS,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Task Breakdown Assistance',
            description:
                'When detecting a large or complex task, the assistant suggests its breakdown into smaller sub-tasks, making it easier for the team to manage and execute.',
            tags: [
                'Ensure Best Practice',
                'Improve Productivity',
                'Improve Delivery Visibility',
            ],
            antiPatterns: ['Inconsistency in Issue Sizes'],
            status: false,
            automationType: AutomationType.AUTOMATION_TASK_BREAKDOWN,
            level: AutomationLevel.TEAM
        },
        {
            name: 'User-requested Task Breakdown Assistance',
            description:
                "Whenever you require assistance in task breakdown, simply turn to the assistant. It will provide options for you, refining both your work and your team's efforts, optimizing your time and enhancing development ease.",
            tags: [
                'Ensure Best Practice',
                'Improve Productivity',
                'Improve Delivery Visibility',
            ],
            antiPatterns: ['Inconsistency in Issue Sizes'],
            status: false,
            automationType: AutomationType.AUTOMATION_USER_REQUESTED_BREAKDOWN,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Monitoring Retroactive Movement of Tasks on the Board',
            description:
                'When an task is moved back, the assistant asks the assignee for the reason, aiming to comprehend and respond effectively. This includes documenting the need for review within the task or offering guidance for proper handling.',
            tags: ['Ensure Best Practice', 'Mitigate Delivery Risks'],
            antiPatterns: ['Team returning issues on the board'],
            status: false,
            automationType: AutomationType.AUTOMATION_RETROACTIVE_MOVEMENT,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Daily Check-In for Team Status Updates',
            description:
                'Provides a daily summary of all significant activities and updates within the last 24 hours. This includes task progress, any delays, tasks that entered or left the WIP status, and any noteworthy communications or impediments. The goal is to support the daily stand-up meeting by offering a concise overview of what has happened and what needs attention, facilitating a more focused and efficient discussion.',
            tags: [
                'Support Daily Stand-Up',
                'Enhance Team Coordination',
                'Highlight Recent Changes',
                'Identify Impediments',
            ],
            antiPatterns: [
                'Summarize tasks that have changed status within the last 24 hours',
            ],
            status: true,
            automationType: AutomationType.AUTOMATION_DAILY_CHECKIN,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Sprint Retro Check-In for Team Status Updates',
            description:
                'Provides a summary of all significant activities and updates within the last Sprint hours. This includes task progress, any delays, tasks that entered or left the WIP status, and any noteworthy communications or impediments. The goal is to support the daily stand-up meeting by offering a concise overview of what has happened and what needs attention, facilitating a more focused and efficient discussion.',
            tags: [
                'Support Sprint Retro',
                'Enhance Team Coordination',
                'Highlight Recent Changes',
                'Identify Impediments',
            ],
            antiPatterns: [
                'Summarize tasks that have changed status within the last Sprint',
            ],
            status: true,
            automationType: AutomationType.AUTOMATION_SPRINT_RETRO,
            level: AutomationLevel.TEAM
        },
        {
            name: 'Executive Check-IN for Team information overview',
            description:
                'Provides a summary of all significant activities and updates for Decision makers',
            tags: [
                'Executive check in',
                'Enhance Team Coordination',
                'Highlight Recent Changes',
                'Identify Impediments',
            ],
            antiPatterns: [
                'Summarize tasks that have changed',
            ],
            status: true,
            automationType: AutomationType.AUTOMATION_EXECUTIVE_CHECKIN,
            level: AutomationLevel.ORGANIZATION
        },
        {
            name: 'Automated Code Review',
            description:
                'Whenever a Pull Request is opened, Kody will perform an automated code review, highlighting improvements, issues, and suggestions to ensure code quality.',
            tags: [
                'Code Review',
            ],
            antiPatterns: [
                'Code Review',
            ],
            status: true,
            automationType: AutomationType.AUTOMATION_CODE_REVIEW,
            level: AutomationLevel.TEAM
        },

    ];

    const repository = await dataSource.getRepository(AutomationModel);

    for (const dataItem of anotherTableDataList) {
        const existing = await repository.findOne({
            where: { name: dataItem.name },
        });

        if (!existing) {
            await repository.save(dataItem);
        }
    }
}

async function installPgVectorExtension(dataSource: DataSource) {
    const instruction = `CREATE EXTENSION IF NOT EXISTS vector;`;

    await dataSource.query(instruction);
}

export default class MainSeeder implements Seeder {
    public async run(
        dataSource: DataSource,
        factoryManager: SeederFactoryManager,
    ): Promise<any> {
        await seedAutomation(dataSource);
        await installPgVectorExtension(dataSource);
        console.log('Seeder finished', factoryManager);
    }
}
