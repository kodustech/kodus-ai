import { AddLibraryKodyRulesUseCase } from './add-library-kody-rules.use-case';
import { ChangeStatusKodyRulesUseCase } from './change-status-kody-rules.use-case';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { DeleteByOrganizationIdKodyRulesUseCase } from './delete-by-organization-id.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from './delete-rule-in-organization-by-id.use-case';
import { FindByOrganizationIdKodyRulesUseCase } from './find-by-organization-id.use-case';
import { FindLibraryKodyRulesUseCase } from './find-library-kody-rules.use-case';
import { FindRuleInOrganizationByRuleIdKodyRulesUseCase } from './find-rule-in-organization-by-id.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { GenerateKodyRulesUseCase } from './generate-kody-rules.use-case';
import { SendRulesNotificationUseCase } from './send-rules-notification.use-case';

export const UseCases = [
    CreateOrUpdateKodyRulesUseCase,
    FindByOrganizationIdKodyRulesUseCase,
    FindRuleInOrganizationByRuleIdKodyRulesUseCase,
    FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
    DeleteByOrganizationIdKodyRulesUseCase,
    DeleteRuleInOrganizationByIdKodyRulesUseCase,
    FindLibraryKodyRulesUseCase,
    AddLibraryKodyRulesUseCase,
    GenerateKodyRulesUseCase,
    ChangeStatusKodyRulesUseCase,
    SendRulesNotificationUseCase,
];
