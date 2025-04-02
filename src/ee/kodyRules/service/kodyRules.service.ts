import {
    IKodyRulesRepository,
    KODY_RULES_REPOSITORY_TOKEN,
} from '@/core/domain/kodyRules/contracts/kodyRules.repository.contract';
import { IKodyRulesService } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { KodyRulesEntity } from '@/core/domain/kodyRules/entities/kodyRules.entity';
import {
    IKodyRule,
    IKodyRules,
    KodyRulesOrigin,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { Inject, Injectable } from '@nestjs/common';
import { CreateKodyRuleDto } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { v4 } from 'uuid';
import { NotFoundException } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import * as libraryKodyRules from './data/library-kody-rules.json';
import {
    KodyRuleFilters,
    LibraryKodyRule,
} from '@/config/types/kodyRules.type';
import { ProgrammingLanguage } from '@/shared/domain/enums/programming-language.enum';

@Injectable()
export class KodyRulesService implements IKodyRulesService {
    constructor(
        @Inject(KODY_RULES_REPOSITORY_TOKEN)
        private readonly kodyRulesRepository: IKodyRulesRepository,
    ) {}

    getNativeCollection() {
        throw new Error('Method not implemented.');
    }

    async create(
        kodyRules: Omit<IKodyRules, 'uuid'>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.create(kodyRules);
    }

    async findById(uuid: string): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.findById(uuid);
    }

    async findOne(
        filter?: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.findOne(filter);
    }

    async find(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity[]> {
        return this.kodyRulesRepository.find(filter);
    }

    async findByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.findByOrganizationId(organizationId);
    }

    async update(
        uuid: string,
        updateData: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.update(uuid, updateData);
    }

    async delete(uuid: string): Promise<boolean> {
        return this.kodyRulesRepository.delete(uuid);
    }

    async addRule(
        uuid: string,
        newRule: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.addRule(uuid, newRule);
    }

    async updateRule(
        uuid: string,
        ruleId: string,
        updateData: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.updateRule(uuid, ruleId, updateData);
    }

    async createOrUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
    ): Promise<Partial<IKodyRule> | IKodyRule | null> {
        const existing = await this.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );

        // If no rules exist for the organization
        if (!existing) {
            if (kodyRule.uuid) {
                throw new NotFoundException('Rule not found');
            }

            const newRule: IKodyRule = {
                uuid: v4(),
                title: kodyRule.title,
                rule: kodyRule.rule,
                path: kodyRule.path,
                severity: kodyRule.severity,
                status: kodyRule.status ?? KodyRulesStatus.ACTIVE,
                repositoryId: kodyRule?.repositoryId,
                examples: kodyRule?.examples,
                origin: kodyRule?.origin ?? KodyRulesOrigin.USER,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const newKodyRules = await this.create({
                organizationId: organizationAndTeamData.organizationId,
                rules: [newRule],
            });

            if (!newKodyRules) {
                throw new Error(
                    'Could not create new Kody rules for organization',
                );
            }

            return newKodyRules.rules[0];
        }

        // If there is no UUID, it is a new rule
        if (!kodyRule.uuid) {
            const newRule: IKodyRule = {
                uuid: v4(),
                title: kodyRule.title,
                rule: kodyRule.rule,
                path: kodyRule.path,
                severity: kodyRule.severity,
                status: kodyRule.status ?? KodyRulesStatus.ACTIVE,
                repositoryId: kodyRule?.repositoryId,
                examples: kodyRule?.examples,
                origin: kodyRule?.origin,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const updatedKodyRules = await this.addRule(existing.uuid, newRule);

            if (!updatedKodyRules) {
                throw new Error('Could not add new rule');
            }

            return updatedKodyRules.rules.find(
                (rule) => rule.uuid === newRule.uuid,
            );
        }

        // If there is a UUID, it is an update
        const existingRule = existing?.rules?.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );

        if (!existingRule) {
            throw new NotFoundException('Rule not found');
        }

        const updatedRule = {
            ...existingRule,
            ...kodyRule,
            updatedAt: new Date(),
        };

        const updatedKodyRules = await this.updateRule(
            existing.uuid,
            kodyRule.uuid,
            updatedRule,
        );

        if (!updatedKodyRules) {
            throw new Error('Could not update rule');
        }

        return updatedKodyRules.rules.find(
            (rule) => rule.uuid === kodyRule.uuid,
        );
    }

    async deleteRule(uuid: string, ruleId: string): Promise<Boolean> {
        return this.kodyRulesRepository.deleteRule(uuid, ruleId);
    }

    async deleteRuleLogically(
        uuid: string,
        ruleId: string,
    ): Promise<KodyRulesEntity | null> {
        return this.kodyRulesRepository.deleteRuleLogically(uuid, ruleId);
    }

    private normalizeTags(tags: string | string[] | undefined): string[] {
        if (!tags) {
            return [];
        }

        // If it's a string, split by commas
        const tagsArray = Array.isArray(tags) ? tags : tags.split(',');

        // Normalize each tag: trim spaces and convert to lowercase
        return tagsArray.map((tag) => tag.trim().toLowerCase());
    }

    private ruleMatchesFilters(
        rule: LibraryKodyRule,
        filters?: KodyRuleFilters,
    ): boolean {
        if (!rule?.title) {
            return false;
        }

        // If there are no filters, do not return anything
        if (!filters) {
            return false;
        }

        // If there is a title in the filter, it must match all words exactly
        if (filters.title) {
            const ruleTitle = rule.title.toLowerCase();
            const searchWords = filters.title.toLowerCase().split(/\s+/);
            if (!searchWords.every((word) => ruleTitle.includes(word))) {
                return false;
            }
        }

        // If there is a severity in the filter, it must match exactly
        if (filters.severity) {
            if (
                rule.severity?.toLowerCase() !== filters.severity.toLowerCase()
            ) {
                return false;
            }
        }

        // If there are tags in the filter (even if empty), they must match exactly
        if (Array.isArray(filters.tags)) {
            const ruleTags = this.normalizeTags(rule.tags);

            // If an empty array is passed, only return rules without tags
            if (filters.tags.length === 0) {
                if (ruleTags.length > 0) {
                    return false;
                }
            } else {
                // If tags are passed, all must be present in the rule
                if (!filters.tags.every((tag) => ruleTags.includes(tag))) {
                    return false;
                }
            }
        }
        return true;
    }

    private addLanguageToRule(
        kodyRule: LibraryKodyRule,
        language: ProgrammingLanguage,
    ): LibraryKodyRule & { language: ProgrammingLanguage } {
        // Returns only the necessary fields
        return {
            uuid: kodyRule.uuid,
            title: kodyRule.title,
            rule: kodyRule.rule,
            why_is_this_important: kodyRule.why_is_this_important,
            severity: kodyRule.severity,
            tags: kodyRule.tags,
            examples: kodyRule.examples || [],
            language,
        };
    }

    async getLibraryKodyRules(
        filters?: KodyRuleFilters,
    ): Promise<
        Record<
            ProgrammingLanguage,
            (LibraryKodyRule & { language: ProgrammingLanguage })[]
        >
    > {
        try {
            const result: Record<
                ProgrammingLanguage,
                (LibraryKodyRule & { language: ProgrammingLanguage })[]
            > = {
                [ProgrammingLanguage.JSTS]: [],
                [ProgrammingLanguage.PYTHON]: [],
                [ProgrammingLanguage.JAVA]: [],
                [ProgrammingLanguage.CSHARP]: [],
                [ProgrammingLanguage.DART]: [],
                [ProgrammingLanguage.RUBY]: [],
            };

            // If there are no filters or no rules, return an empty object
            if (!filters || !libraryKodyRules) {
                return result;
            }

            for (const language in libraryKodyRules) {
                if (
                    !Object.prototype.hasOwnProperty.call(
                        libraryKodyRules,
                        language,
                    )
                ) {
                    continue;
                }

                const programmingLanguage = language as ProgrammingLanguage;
                if (
                    filters?.language &&
                    filters.language !== programmingLanguage
                ) {
                    continue;
                }

                const rules = libraryKodyRules[language];
                if (!Array.isArray(rules)) {
                    continue;
                }

                const validRules = rules
                    .filter(
                        (rule) =>
                            rule && typeof rule === 'object' && rule.title,
                    )
                    .map((rule) => ({
                        ...rule,
                        tags: this.normalizeTags(rule.tags),
                    }));

                const filteredRules = validRules
                    .filter((rule) => this.ruleMatchesFilters(rule, filters))
                    .map((rule) =>
                        this.addLanguageToRule(rule, programmingLanguage),
                    );

                if (filteredRules.length > 0) {
                    result[programmingLanguage] = filteredRules;
                }
            }

            return result;
        } catch (error) {
            console.error('Error in getLibraryKodyRules:', error);
            return {
                [ProgrammingLanguage.JSTS]: [],
                [ProgrammingLanguage.PYTHON]: [],
                [ProgrammingLanguage.JAVA]: [],
                [ProgrammingLanguage.CSHARP]: [],
                [ProgrammingLanguage.DART]: [],
                [ProgrammingLanguage.RUBY]: [],
            };
        }
    }
}
