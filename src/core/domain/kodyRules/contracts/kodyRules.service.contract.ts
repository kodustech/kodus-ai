import { IKodyRulesRepository } from './kodyRules.repository.contract';
import { CreateKodyRuleDto } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IKodyRule } from '../interfaces/kodyRules.interface';
import { KodyRuleFilters } from '@/config/types/kodyRules.type';

export const KODY_RULES_SERVICE_TOKEN = 'KODY_RULES_SERVICE_TOKEN';

export interface IKodyRulesService extends IKodyRulesRepository {
    createOrUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
    ): Promise<Partial<IKodyRule> | IKodyRule | null>;

    getLibraryKodyRules(filters?: KodyRuleFilters): Promise<any | null>;
}
