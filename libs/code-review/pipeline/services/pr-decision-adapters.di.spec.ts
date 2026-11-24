import { Test } from '@nestjs/testing';

import {
    DECISION_RECORDER_TOKEN,
    HOST_DRIVER_TOKEN,
    L0_ASSESSOR_TOKEN,
    L1_ASSESSOR_TOKEN,
    L2_ASSESSOR_TOKEN,
    L3_ASSESSOR_TOKEN,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { REPOSITORY_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { KodusGraphCli } from '@libs/code-review/infrastructure/adapters/services/graph/kodus-graph-cli';

import { PrDecisionHostDriverService } from '../services/pr-decision-host-driver.service';
import { PrDecisionL0AssessorService } from '../services/pr-decision-l0-assessor.service';
import { PrDecisionL1AssessorService } from '../services/pr-decision-l1-assessor.service';
import { PrDecisionL2AssessorService } from '../services/pr-decision-l2-assessor.service';
import { PrDecisionL3AssessorService } from '../services/pr-decision-l3-assessor.service';
import { PrDecisionRecorderService } from '../services/pr-decision-recorder.service';

/**
 * The reconciler's port bindings must be constructible.
 *
 * A missing dependency here is not a runtime failure on the first PR —
 * Nest resolves every provider eagerly, so the API refuses to boot with
 * `UnknownDependenciesException`. For a module wired into the review
 * pipeline that is the worst possible failure mode: the whole product goes
 * down, not one feature.
 *
 * The metadata-only assertions in `pr-decision-wiring.spec.ts` cannot catch
 * it: they read the module's declared imports and providers without asking
 * Nest to resolve them. This spec does — it builds a module context with
 * the same bindings the pipeline module declares, and asks Nest to
 * construct each one.
 *
 * The bindings are reproduced here rather than imported from the pipeline
 * module, because that module pulls in the whole review pipeline (a
 * DataSource, the workflow queue, every agent). What is under test is the
 * adapters' own dependency lists, which is what made the API refuse to
 * boot.
 */
describe('Reconciler port bindings (DI resolution)', () => {
    const STUB = class {};

    /**
     * The same bindings `CodeReviewPipelineModule` declares, with the real
     * adapter classes. If an adapter gains a dependency and the module does
     * not provide it, this fails.
     */
    function buildModule() {
        return Test.createTestingModule({
            providers: [
                // The real dependencies, as STUBS. `overrideProvider` only
                // replaces a provider that is already registered, so a
                // dependency the module does not declare has to be supplied
                // here — and that is the case under test.
                { provide: CodeManagementService, useValue: new STUB() },
                {
                    provide: COMMENT_MANAGER_SERVICE_TOKEN,
                    useValue: new STUB(),
                },
                { provide: PULL_REQUESTS_SERVICE_TOKEN, useValue: new STUB() },
                { provide: REPOSITORY_SERVICE_TOKEN, useValue: new STUB() },
                { provide: KodusGraphCli, useValue: new STUB() },
                {
                    provide: L0_ASSESSOR_TOKEN,
                    useClass: PrDecisionL0AssessorService,
                },
                {
                    provide: L1_ASSESSOR_TOKEN,
                    useClass: PrDecisionL1AssessorService,
                },
                {
                    provide: L2_ASSESSOR_TOKEN,
                    useClass: PrDecisionL2AssessorService,
                },
                {
                    provide: L3_ASSESSOR_TOKEN,
                    useClass: PrDecisionL3AssessorService,
                },
                {
                    provide: HOST_DRIVER_TOKEN,
                    useClass: PrDecisionHostDriverService,
                },
                {
                    provide: DECISION_RECORDER_TOKEN,
                    useClass: PrDecisionRecorderService,
                },
            ],
        }).compile();
    }

    it('constructs every adapter behind its port', async () => {
        const moduleRef = await buildModule();

        const tokens = [
            L0_ASSESSOR_TOKEN,
            L1_ASSESSOR_TOKEN,
            L2_ASSESSOR_TOKEN,
            L3_ASSESSOR_TOKEN,
            HOST_DRIVER_TOKEN,
            DECISION_RECORDER_TOKEN,
        ];

        for (const token of tokens) {
            expect(moduleRef.get(token, { strict: false })).toBeDefined();
        }

        await moduleRef.close();
    });

    it('names every dependency the host driver and the recorder inject', async () => {
        // The host driver injects `CodeManagementService` by class and the
        // comment manager by token; the recorder injects the PRs service by
        // token. If the pipeline module did not import the modules that
        // provide them, the API refuses to boot — which is exactly what
        // happened once. Listing the dependencies here makes that failure
        // explicit rather than discovered at deploy time.
        const moduleRef = await Test.createTestingModule({
            providers: [
                { provide: CodeManagementService, useValue: new STUB() },
                {
                    provide: COMMENT_MANAGER_SERVICE_TOKEN,
                    useValue: new STUB(),
                },
                { provide: PULL_REQUESTS_SERVICE_TOKEN, useValue: new STUB() },
                {
                    provide: HOST_DRIVER_TOKEN,
                    useClass: PrDecisionHostDriverService,
                },
                {
                    provide: DECISION_RECORDER_TOKEN,
                    useClass: PrDecisionRecorderService,
                },
            ],
        }).compile();

        expect(
            moduleRef.get(HOST_DRIVER_TOKEN, { strict: false }),
        ).toBeDefined();
        expect(
            moduleRef.get(DECISION_RECORDER_TOKEN, { strict: false }),
        ).toBeDefined();
        await moduleRef.close();
    });
});
