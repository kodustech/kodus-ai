import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BugRatioArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/bugRatio.artifact';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { WipLimitArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/wipLimit.artifact';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';

describe('Calculate WIP Limit Artifact', () => {
    let app: NestExpressApplication;
    let wipLimit: WipLimitArtifact;
    let artifact: IArtifact;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                forwardRef(() => DatabaseModule),
                forwardRef(() => TeamArtifactsModule),
            ],
        }).compile();

        app = moduleRef.createNestApplication<NestExpressApplication>();
        app.useGlobalPipes(new ValidationPipe({ transform: true }));

        wipLimit = new WipLimitArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) => artifact.name === ArtifactName.WIPLimit,
            );
    });

    it('Should return positive artifact, replacing params', async () => {
        const positivePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        positivePayload.artifact = artifact;

        positivePayload.workItems.push({
            key: 'KC-259',
            id: '10315',
            title: 'New prompt for task quality evaluation',
            issueType: 'Small Wins',
            workItemCreatedAt: '2024-02-29T17:33:05.197-0300',
            workItemType: {
                name: 'Small Wins',
                id: '10015',
                description: '',
                subtask: false,
            },
            description:
                "Specification: We identified that the current prompt evaluating the quality of task descriptions is not working well. For example, there is a task that is well-written and complete, but sometimes the prompt scores it as 0 and other times as 70. This is an issue because notifying the user that a task is poorly written and offering help to improve it might give the impression that Kody is not evaluating quality properly. The current prompt runs on version 3.5 16K turbo of OpenAI's chat, and this new prompt was executed on version gpt-4-turbo-preview. Since costs vary significantly, the idea is to use this new prompt only for automation that checks the quality of task descriptions entering TO DO, while keeping the diagnosis running with the current prompt in version 3.5. However, if making this separation (because today it is all one thing) takes too much development time, for example, more than double the time it would take to just switch to the new version, we will also switch the diagnosis to the new version along with the automation. Execution settings for the new prompt: Provider: ChatOpenAI, Model: gpt-4-turbo, Temperature: 0. New Prompt: Disregard everything I have sent so far. You are Kody, the virtual assistant for software delivery management at Kodus. As a specialist in agility and software delivery, you are here to evaluate a set of tasks based on specific criteria. Please evaluate the tasks using the criteria and weights specified below. ## CRITERIA AND WEIGHTS - Defines dependencies on other activities (Weight: 0.15) - Has Acceptance Criteria/Definition of Done (Weight: 0.15) - Technically clear description (Weight: 0.10) - Follows the INVEST Framework standard (Weight: 0.10) - Clear and Assertive Description (Weight: 0.10) - Has defined Use Cases (Weight: 0.08) - Clear definition of added value to the project (Weight: 0.08) - Explicit priority (Weight: 0.07) - Definition of constraints (Weight: 0.07) - References links or supporting documents (Weight: 0.05) - At least 1000 Characters (Weight: 0.05) ## EVALUATION FORMULA Take each item in the array sent and calculate the score individually. For each item, save the workItemId and workItemKey to use in the return object. For each item, multiply the evaluation of each criterion by its weight and sum all the results. The total score must be in the range of 0 to 100. The score must strictly reflect the quality of the task in relation to the established criteria. For each item, after the calculation, add the result to the return array. ## OBSERVATION: The observation about the evaluation should highlight the aspects that were satisfactorily met and which areas need improvement. ## EXPECTED RETURN Let's simulate an example of input and return for you to understand the references. [{description: 'This is an example activity', workItemId: 10038, workItemKey: 'GTM-123' }, {description: 'This is another example activity', workItemId: 10045, workItemKey: 'GTM-133' }] ## YOU CAN ONLY RETURN IN THE FORMAT BELOW \"JSON STANDARD\" Output object - always follow this standard, without any additional elaboration: [{score: [Score], obs: 'Example observation', workItemId: 10038, workItemKey: 'GTM-123', obs: 'Test observation 1'}] Use the examples above to reference the fields workItemId and workItemKey and to construct the return object. ## TASKS TO BE EVALUATED (INPUT OBJECT)",
            priority: 'Medium',
            responsible: 'Gabriel Malinosqui',
            status: {
                name: 'In Homolog',
                id: '10008',
                statusCategory: { name: 'In Progress', id: 4 },
            },
            flagged: false,
        });

        positivePayload.workItems.push({
            key: 'KC-260',
            id: '10316',
            title: 'New prompt for task quality evaluation',
            issueType: 'Small Wins',
            workItemCreatedAt: '2024-02-29T17:33:05.197-0300',
            workItemType: {
                name: 'Small Wins',
                id: '10015',
                description: '',
                subtask: false,
            },
            description:
                "Specification: We identified that the current prompt evaluating the quality of task descriptions is not working well. For example, there is a task that is well-written and complete, but sometimes the prompt scores it as 0 and other times as 70. This is an issue because notifying the user that a task is poorly written and offering help to improve it might give the impression that Kody is not evaluating quality properly. The current prompt runs on version 3.5 16K turbo of OpenAI's chat, and this new prompt was executed on version gpt-4-turbo-preview. Since costs vary significantly, the idea is to use this new prompt only for automation that checks the quality of task descriptions entering TO DO, while keeping the diagnosis running with the current prompt in version 3.5. However, if making this separation (because today it is all one thing) takes too much development time, for example, more than double the time it would take to just switch to the new version, we will also switch the diagnosis to the new version along with the automation. Execution settings for the new prompt: Provider: ChatOpenAI, Model: gpt-4-turbo, Temperature: 0. New Prompt: Disregard everything I have sent so far. You are Kody, the virtual assistant for software delivery management at Kodus. As a specialist in agility and software delivery, you are here to evaluate a set of tasks based on specific criteria. Please evaluate the tasks using the criteria and weights specified below. ## CRITERIA AND WEIGHTS - Defines dependencies on other activities (Weight: 0.15) - Has Acceptance Criteria/Definition of Done (Weight: 0.15) - Technically clear description (Weight: 0.10) - Follows the INVEST Framework standard (Weight: 0.10) - Clear and Assertive Description (Weight: 0.10) - Has defined Use Cases (Weight: 0.08) - Clear definition of added value to the project (Weight: 0.08) - Explicit priority (Weight: 0.07) - Definition of constraints (Weight: 0.07) - References links or supporting documents (Weight: 0.05) - At least 1000 Characters (Weight: 0.05) ## EVALUATION FORMULA Take each item in the array sent and calculate the score individually. For each item, save the workItemId and workItemKey to use in the return object. For each item, multiply the evaluation of each criterion by its weight and sum all the results. The total score must be in the range of 0 to 100. The score must strictly reflect the quality of the task in relation to the established criteria. For each item, after the calculation, add the result to the return array. ## OBSERVATION: The observation about the evaluation should highlight the aspects that were satisfactorily met and which areas need improvement. ## EXPECTED RETURN Let's simulate an example of input and return for you to understand the references. [{description: 'This is an example activity', workItemId: 10038, workItemKey: 'GTM-123' }, {description: 'This is another example activity', workItemId: 10045, workItemKey: 'GTM-133' }] ## YOU CAN ONLY RETURN IN THE FORMAT BELOW \"JSON STANDARD\" Output object - always follow this standard, without any additional elaboration: [{score: [Score], obs: 'Example observation', workItemId: 10038, workItemKey: 'GTM-123', obs: 'Test observation 1'}] Use the examples above to reference the fields workItemId and workItemKey and to construct the return object. ## TASKS TO BE EVALUATED (INPUT OBJECT)",
            priority: 'Medium',
            responsible: 'Gabriel Malinosqui',
            status: {
                name: 'In Homolog',
                id: '10008',
                statusCategory: { name: 'In Progress', id: 4 },
            },
            flagged: false,
        });

        const artifactResult = await wipLimit.execute(positivePayload);

        expect(artifactResult).toHaveProperty('name');
        expect(artifactResult).toHaveProperty('description');
        expect(artifactResult).toHaveProperty('analysisInitialDate');
        expect(artifactResult).toHaveProperty('analysisFinalDate');
        expect(artifactResult).toHaveProperty('resultType');
        expect(artifactResult).toHaveProperty('impactArea');
        expect(artifactResult).toHaveProperty('whyIsImportant');
        expect(artifactResult).toHaveProperty('teamId');
        expect(artifactResult).toHaveProperty('organizationId');
        expect(artifactResult).toHaveProperty('criticality');

        expect(artifactResult.name).toBe(ArtifactName.WIPLimit);
        expect(artifactResult.resultType).toBe('Positive');
        expect(artifactResult.description).toContain(
            'The team respected the recommended WIP limit, as the number of items worked on in WIP was 2, which is less than 2 - double the number of team members. This avoids bottlenecks, overload, and maintains focus and development quality.',
        );
    });

    it('Should return negative artifact, replacing params', async () => {
        const negativePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        negativePayload.artifact = artifact;
        negativePayload.workItems = JSON.parse(
            JSON.stringify(require('./mock/workItems.json').workItems),
        );

        const artifactResult = await wipLimit.execute(negativePayload);

        expect(negativePayload.workItems.length).toBe(6);
        expect(negativePayload.teamMembers.members.length).toBe(1);

        expect(artifactResult).toHaveProperty('name');
        expect(artifactResult).toHaveProperty('description');
        expect(artifactResult).toHaveProperty('analysisInitialDate');
        expect(artifactResult).toHaveProperty('analysisFinalDate');
        expect(artifactResult).toHaveProperty('resultType');
        expect(artifactResult).toHaveProperty('impactArea');
        expect(artifactResult).toHaveProperty('whyIsImportant');
        expect(artifactResult).toHaveProperty('teamId');
        expect(artifactResult).toHaveProperty('organizationId');
        expect(artifactResult).toHaveProperty('criticality');
        expect(artifactResult).toHaveProperty('frequenceType');

        expect(artifactResult.name).toBe(ArtifactName.WIPLimit);
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            'The team did not respect the recommended WIP limit, as the number of items worked on in WIP was 6, which is greater than 2 - double the number of team members. This can cause risks of delay, lower delivery quality, and more stress on the team, impacting satisfaction and costs.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult = await wipLimit.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
