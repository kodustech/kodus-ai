/**
 * Regression test — onboarding "team_automation" race.
 *
 * `POST /code-management/repositories` (registerRepo) runs this sequence,
 * see create-repositories.ts:101-109:
 *
 *   1. ActiveCodeManagementTeamAutomationsUseCase.execute(teamId)
 *        -> UpdateOrCreateTeamAutomationUseCase.execute(...)
 *             -> executeAutomation.setupStrategy(...)   // registers the row, status:false
 *   2. ActiveCodeReviewAutomationUseCase.execute(teamId, automations)
 *        -> flips that row to status:true
 *
 * The bug: UpdateOrCreateTeamAutomationUseCase did NOT await setupStrategy, so
 * step 2 could run its find() before the row from step 1 was committed. When
 * that happened the row stayed status:false and every webhook for that team was
 * silently dropped by WebhookContextService (which queries status:true).
 *
 * These tests reproduce the race deterministically by giving register() a
 * realistic latency: with the missing await the row lands too late and stays
 * inactive; with the fix the whole chain is awaited and the row is active by
 * the time step 2 runs.
 */
import { ActiveCodeManagementTeamAutomationsUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-manegement-automations.use-case';
import { ActiveCodeReviewAutomationUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-review-automation.use-case';
import { UpdateOrCreateTeamAutomationUseCase } from '@libs/automation/application/use-cases/teamAutomation/updateOrCreateTeamAutomationUseCase';
import { UpdateTeamAutomationStatusUseCase } from '@libs/automation/application/use-cases/teamAutomation/updateTeamAutomationStatusUseCase';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';

const REGISTER_DELAY_MS = 40;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TeamAutomationRow = {
    uuid: string;
    status: boolean;
    team: { uuid: string };
    automation: { uuid: string };
};

const CODE_REVIEW_AUTOMATION = {
    uuid: 'automation-code-review',
    automationType: AutomationType.AUTOMATION_CODE_REVIEW,
    status: true,
};

/**
 * In-memory stand-in for TeamAutomationService. `register` deliberately takes
 * REGISTER_DELAY_MS to model the INSERT round-trip — that latency is exactly
 * what the missing `await` used to skip over.
 */
const createTeamAutomationServiceFake = () => {
    const store: TeamAutomationRow[] = [];
    let sequence = 0;

    return {
        store,
        find: jest.fn(async (filter: any = {}) => {
            return store.filter((row) => {
                if (filter?.team?.uuid && row.team.uuid !== filter.team.uuid) {
                    return false;
                }
                if (
                    filter?.automation?.uuid &&
                    row.automation.uuid !== filter.automation.uuid
                ) {
                    return false;
                }
                if (
                    filter?.status !== undefined &&
                    row.status !== filter.status
                ) {
                    return false;
                }
                return true;
            });
        }),
        register: jest.fn(async (teamAutomation: any) => {
            await delay(REGISTER_DELAY_MS);
            const row: TeamAutomationRow = {
                uuid: `team-automation-${++sequence}`,
                status: teamAutomation.status,
                team: teamAutomation.team,
                automation: teamAutomation.automation,
            };
            store.push(row);
            return row;
        }),
        update: jest.fn(async (filter: any, data: any) => {
            const row = store.find((r) => r.uuid === filter?.uuid);
            if (row && data?.status !== undefined) {
                row.status = data.status;
            }
            return row;
        }),
    };
};

/**
 * Wires the real use cases that registerRepo chains together, backed by the
 * in-memory team automation store.
 */
const createOnboardingHarness = () => {
    const teamAutomationService = createTeamAutomationServiceFake();

    // Mirrors AutomationCodeReviewService.setup(): registers the team
    // automation row with status:false. Activation to true happens later,
    // in ActiveCodeReviewAutomationUseCase.
    const executeAutomation = {
        setupStrategy: jest.fn(
            async (_automationType: string, payload: any) => {
                await teamAutomationService.register({
                    status: false,
                    automation: { uuid: CODE_REVIEW_AUTOMATION.uuid },
                    team: { uuid: payload.teamId },
                });
            },
        ),
    };

    const automationService = {
        find: jest.fn(async () => [CODE_REVIEW_AUTOMATION]),
    };

    const profileConfigService = {
        findOne: jest.fn(async () => null),
    };

    const request = {
        user: { organization: { uuid: 'org-1' } },
    } as any;

    const updateTeamAutomationStatusUseCase =
        new UpdateTeamAutomationStatusUseCase(
            teamAutomationService as any,
            request,
        );

    const updateOrCreateTeamAutomationUseCase =
        new UpdateOrCreateTeamAutomationUseCase(
            teamAutomationService as any,
            executeAutomation as any,
            profileConfigService as any,
            request,
        );

    const activeCodeManagementUseCase =
        new ActiveCodeManagementTeamAutomationsUseCase(
            updateOrCreateTeamAutomationUseCase,
            automationService as any,
            {} as any,
            {} as any,
            request,
        );

    const activeCodeReviewUseCase = new ActiveCodeReviewAutomationUseCase(
        updateTeamAutomationStatusUseCase,
        teamAutomationService as any,
        request,
    );

    return {
        teamAutomationService,
        executeAutomation,
        updateOrCreateTeamAutomationUseCase,
        activeCodeManagementUseCase,
        activeCodeReviewUseCase,
    };
};

describe('Team automation onboarding race', () => {
    it('registers the code review automation as ACTIVE after the registerRepo onboarding sequence', async () => {
        const harness = createOnboardingHarness();
        const teamId = 'team-1';

        // Reproduces create-repositories.ts:101-109 exactly.
        const codeManagementTeamAutomations =
            await harness.activeCodeManagementUseCase.execute(teamId);
        await harness.activeCodeReviewUseCase.execute(
            teamId,
            codeManagementTeamAutomations as any,
        );

        // Let any un-awaited register() settle before asserting, so a failure
        // reads as "row exists but status:false" rather than "row missing".
        await delay(REGISTER_DELAY_MS + 20);

        const rows = harness.teamAutomationService.store;
        expect(rows).toHaveLength(1);
        expect(rows[0].automation.uuid).toBe(CODE_REVIEW_AUTOMATION.uuid);
        // The bug: ActiveCodeReviewAutomationUseCase ran its find() before the
        // un-awaited register() committed, so the row was never flipped to true
        // and every webhook for this team is dropped by WebhookContextService.
        expect(rows[0].status).toBe(true);
    });

    it('does not resolve UpdateOrCreateTeamAutomationUseCase.execute() until setupStrategy has finished', async () => {
        const harness = createOnboardingHarness();

        await harness.updateOrCreateTeamAutomationUseCase.execute({
            teamId: 'team-1',
            automations: [
                {
                    automationUuid: CODE_REVIEW_AUTOMATION.uuid,
                    automationType: CODE_REVIEW_AUTOMATION.automationType,
                    status: true,
                },
            ],
        } as any);

        // With the missing await, execute() resolves while register() is still
        // in flight and the row has not landed yet.
        expect(harness.teamAutomationService.store).toHaveLength(1);

        // Settle the (formerly un-awaited) register() so it doesn't leak.
        await delay(REGISTER_DELAY_MS + 20);
    });
});
