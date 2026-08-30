#!/usr/bin/env npx ts-node
/**
 * Live check for the proactive-actions behavior (issue #1761).
 *
 * Drives the REAL `ConversationAgentProvider` against the real BYOK model and
 * the org's real MCP connection, over a PR thread shaped like the one a webhook
 * builds. Two turns, because that is the behavior under test:
 *
 *   1. the developer explains a false positive  -> Kody should OFFER to persist it
 *   2. the developer confirms                   -> Kody should CALL the write tool
 *
 * Run inside the api/worker container (it needs the app env):
 *   docker exec kodus_api npx ts-node scripts/dev/kody-proactive-e2e.ts
 *
 * It writes a real memory rule on turn 2 — intended only for a disposable
 * environment. `--cleanup` soft-deletes memories this script created.
 */
import 'dotenv/config';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { EventEmitterModule } from '@nestjs/event-emitter';

import { AgentsModule } from '@libs/agents/modules/agents.module';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedCoreModule } from '@libs/shared/infrastructure/shared-core.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { ConversationAgentProvider } from '@libs/agents/infrastructure/services/agents/conversationAgent';
import { createThreadId } from '@libs/common/utils/thread-id';

@Module({
    imports: [
        EventEmitterModule.forRoot(),
        SharedCoreModule,
        SharedConfigModule,
        SharedLogModule,
        SharedObservabilityModule,
        SharedPostgresModule.forRoot({ poolSize: 4 }),
        SharedMongoModule.forRoot(),
        RabbitMQWrapperModule.register({ enableConsumers: false }),
        AgentsModule,
    ],
})
class ProactiveE2EModule {}

const ORGANIZATION_ID = '2fc807c0-daa5-4074-b0be-0e30b6fbe6cc';
const TEAM_ID = '92ec0b65-a1ea-4cd8-916e-2a97de4de39f';
const REPOSITORY = { id: '670345891', name: 'kodus-orchestrator' };
const PR_NUMBER = 980;
const KODY_COMMENT_ID = 3715732515;
const SUGGESTION_ID = '6a72438cc13382913c574b96';
// A run reuses the thread record unless given a fresh id — pass RUN_ID to get
// a clean thread (no replayed history from an earlier run).
const RUN_ID = process.env.RUN_ID ?? '1';
const DEVELOPER = { id: Number(RUN_ID), username: 'dev-e2e' };

const TURN_1 =
    '@kody this is a false positive — in this repo MsTeamsService deliberately keeps its own block assembly, because the Teams payload contract differs from Slack and sharing a helper would couple two formats we intentionally keep separate.';
const TURN_2 = '@kody yes, please record that.';

function prepareContext() {
    return {
        gitUser: DEVELOPER,
        userQuestion: TURN_1,
        platformType: 'GITHUB',
        repository: { ...REPOSITORY, defaultBranch: 'main' },
        pullRequestDescription:
            'Drop empty blocks from the communication payload.',
        pullRequest: {
            pullRequestNumber: PR_NUMBER,
            headRef: 'test/duplicate-logic-e2e-2',
            baseRef: 'main',
        },
        codeManagementContext: {
            originalComment: {
                suggestionCommentId: KODY_COMMENT_ID,
                suggestionFilePath:
                    'src/core/infrastructure/adapters/services/slack/slack.service.ts',
                suggestionText:
                    'Incomplete empty-block fix in SlackService.constructResponseCommunicationBlock leaves its structural twin in msTeams.service.ts unfiltered. Extract the block assembly/filter into a shared helper and call it from both SlackService and MsTeamsService.',
                suggestionId: SUGGESTION_ID,
                label: 'duplicate_logic',
            },
            othersReplies: [],
        },
    };
}

async function main() {
    const app = await NestFactory.createApplicationContext(ProactiveE2EModule, {
        logger: ['warn', 'error'],
    });

    try {
        const agent = app.get(ConversationAgentProvider);
        const organizationAndTeamData = {
            organizationId: ORGANIZATION_ID,
            teamId: TEAM_ID,
        };
        const thread = createThreadId(
            {
                organizationId: ORGANIZATION_ID,
                teamId: TEAM_ID,
                repositoryId: REPOSITORY.id,
                userId: DEVELOPER.id,
                suggestionCommentId: KODY_COMMENT_ID,
            },
            { prefix: 'cmc' },
        );

        console.log(`\n=== thread ${thread.id}`);

        for (const [label, prompt] of [
            ['TURN 1 — developer explains the false positive', TURN_1],
            ['TURN 2 — developer confirms', TURN_2],
        ] as const) {
            console.log(`\n=== ${label}\n> ${prompt}\n`);
            const answer = await agent.execute(prompt, {
                organizationAndTeamData,
                prepareContext: prepareContext(),
                thread,
            } as never);
            console.log(answer);
        }
    } finally {
        await app.close();
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
