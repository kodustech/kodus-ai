import { AddLibraryKodyRulesUseCase } from './add-library-kody-rules.use-case';
import { ChangeStatusKodyRulesUseCase } from './change-status-kody-rules.use-case';
import { CheckSyncStatusUseCase } from './check-sync-status.use-case';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from './delete-rule-in-organization-by-id.use-case';
import { FindByOrganizationIdKodyRulesUseCase } from './find-by-organization-id.use-case';
import { FindLibraryKodyRulesBucketsUseCase } from './find-library-kody-rules-buckets.use-case';
import { FindLibraryKodyRulesWithFeedbackUseCase } from './find-library-kody-rules-with-feedback.use-case';
import { FindLibraryKodyRulesUseCase } from './find-library-kody-rules.use-case';
import { FindRecommendedKodyRulesUseCase } from './find-recommended-kody-rules.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { FindSuggestionsByRuleUseCase } from './find-suggestions-by-rule.use-case';
import { GenerateKodyRulesUseCase } from './generate-kody-rules.use-case';
import { GetInheritedRulesKodyRulesUseCase } from './get-inherited-kody-rules.use-case';
import { GetRulesLimitStatusUseCase } from './get-rules-limit-status.use-case';
import { FastSyncIdeRulesUseCase } from './fast-sync-ide-rules.use-case';
import { ResyncRulesFromIdeUseCase } from './resync-rules-from-ide.use-case';
import { SendRulesNotificationUseCase } from './send-rules-notification.use-case';
import { SyncSelectedRepositoriesKodyRulesUseCase } from './sync-selected-repositories.use-case';
import { ImportFastKodyRulesUseCase } from './import-fast-kody-rules.use-case';

export const UseCases = [
    CreateOrUpdateKodyRulesUseCase,
    FindByOrganizationIdKodyRulesUseCase,
    FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
    DeleteRuleInOrganizationByIdKodyRulesUseCase,
    FindLibraryKodyRulesUseCase,
    FindLibraryKodyRulesWithFeedbackUseCase,
    FindLibraryKodyRulesBucketsUseCase,
    FindRecommendedKodyRulesUseCase,
    AddLibraryKodyRulesUseCase,
    GenerateKodyRulesUseCase,
    ChangeStatusKodyRulesUseCase,
    SendRulesNotificationUseCase,
    SyncSelectedRepositoriesKodyRulesUseCase,
    CheckSyncStatusUseCase,
    GetInheritedRulesKodyRulesUseCase,
    GetRulesLimitStatusUseCase,
    FindSuggestionsByRuleUseCase,
    ResyncRulesFromIdeUseCase,
    FastSyncIdeRulesUseCase,
    ImportFastKodyRulesUseCase,
];
