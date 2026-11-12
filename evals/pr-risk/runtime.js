// Production services with frozen provider/database responses at their I/O boundaries.
const { EVAL_ORG } = require('../shared/model-route');
const {
    AssessPrRiskStage,
} = require('../../libs/code-review/pipeline/stages/assess-pr-risk.stage.ts');
const {
    PrRiskAssessmentService,
} = require('../../libs/code-review/pipeline/services/pr-risk-assessment.service.ts');
const {
    DecidePrApprovalStage,
} = require('../../libs/code-review/pipeline/stages/decide-pr-approval.stage.ts');
const {
    ApprovalPoliciesService,
} = require('../../libs/code-review/pipeline/services/approval-policies.service.ts');
const {
    CodeManagementService,
} = require('../../libs/platform/infrastructure/adapters/services/codeManagement.service.ts');
const {
    PlatformIntegrationFactory,
} = require('../../libs/platform/infrastructure/adapters/services/platformIntegration.factory.ts');
const {
    IntegrationService,
} = require('../../libs/integrations/infrastructure/adapters/services/integration.service.ts');
const {
    OrganizationService,
} = require('../../libs/organization/infrastructure/adapters/services/organization.service.ts');
const {
    OrganizationParametersService,
} = require('../../libs/organization/infrastructure/adapters/services/organizationParameters.service.ts');
const {
    CodeAreaRiskMapService,
} = require('../../libs/platformData/infrastructure/adapters/services/code-area-risk-map.service.ts');
const {
    ConditionalApprovalAccessService,
} = require('../../libs/code-review/infrastructure/approval/conditional-approval-access.service.ts');
const {
    FeatureGateService,
} = require('../../libs/feature-gate/application/feature-gate.service.ts');
const { LicenseService } = require('../../libs/ee/license/license.service.ts');
const {
    PermissionValidationService,
} = require('../../libs/ee/shared/services/permissionValidation.service.ts');
const {
    PlatformType,
    OrganizationParametersKey,
} = require('../../libs/core/domain/enums');

function stageFor(item, storedConfig, { withMap = false } = {}) {
    const pr = {
        number: item.prNumber || 1,
        title: item.title,
        body: item.body || '',
        labels: item.labels ?? [],
        user: { login: item.author || 'alice' },
        head: { sha: item.headSha || 'head' },
        base: { sha: item.baseSha || 'base' },
        stats: { total_files: item.files.length },
    };
    // Stored rows, provider snapshots, Mongo reads and billing HTTP responses
    // are the data boundaries; every service above those boundaries is real.
    const integrations = new IntegrationService(
        {
            findOne: async (filter) =>
                filter.organization?.uuid === EVAL_ORG.organizationId &&
                filter.team?.uuid === EVAL_ORG.teamId &&
                filter.status === true &&
                filter.integrationCategory === 'CODE_MANAGEMENT'
                    ? {
                          platform: PlatformType.GITHUB,
                          integrationCategory: 'CODE_MANAGEMENT',
                          status: true,
                          organization: { uuid: EVAL_ORG.organizationId },
                          team: { uuid: EVAL_ORG.teamId },
                      }
                    : null,
        },
        {},
    );
    const factory = new PlatformIntegrationFactory();
    factory.registerCodeManagementService(PlatformType.GITHUB, {
        getPullRequest: async () => pr,
        getFilesByPullRequestId: async () => item.files,
    });
    const host = new CodeManagementService(integrations, factory);
    const parameters = new OrganizationParametersService({
        findByKey: async (key, org) =>
            key === OrganizationParametersKey.BYOK_CONFIG &&
            org.organizationId === EVAL_ORG.organizationId
                ? { configValue: storedConfig }
                : null,
    });
    const maps = new CodeAreaRiskMapService({
        findOne: () => ({
            lean: () => ({
                exec: async () =>
                    withMap && item.areaMap ? { snapshot: item.areaMap } : null,
            }),
        }),
    });
    const organizations = new OrganizationService({
        findOne: async (filter) =>
            filter.uuid === EVAL_ORG.organizationId
                ? { releaseTrack: 'beta' }
                : null,
    });
    const license = new LicenseService();
    license.licenseRequest = {
        get: async (url, request) => {
            if (
                url !== 'validate-org-license' ||
                request?.params?.organizationId !== EVAL_ORG.organizationId ||
                request?.params?.teamId !== EVAL_ORG.teamId
            )
                throw new Error('Unexpected risk contract billing request');
            return {
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_monthly',
            };
        },
    };
    const access = new ConditionalApprovalAccessService(
        new FeatureGateService({}),
        organizations,
        license,
    );
    const permissions = new PermissionValidationService(license, parameters);
    return {
        pr,
        approvalStage: new DecidePrApprovalStage(
            host,
            maps,
            access,
            new ApprovalPoliciesService(host, parameters, access, permissions),
        ),
        stage: new AssessPrRiskStage(
            new PrRiskAssessmentService(
                host,
                maps,
                parameters,
                access,
                permissions,
            ),
        ),
    };
}

module.exports = { stageFor };
