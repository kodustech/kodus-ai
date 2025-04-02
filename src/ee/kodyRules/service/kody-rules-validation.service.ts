/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';

/**
 * Service for validating Kody Rules in cloud mode
 */
@Injectable()
export class KodyRulesValidationService {
    private readonly MAX_KODY_RULES = 10;
    private readonly isCloud: boolean;

    constructor() {
        this.isCloud =
            (process.env.API_CLOUD_MODE || 'true').toLowerCase() === 'true';
    }

    /**
     * Validates if the number of rules is within the allowed limit
     * @param currentRules Current number of rules
     * @param newRules Number of new rules to add
     * @returns true if the number of rules is within the limit, false otherwise
     */
    validateRulesLimit(currentRules: number, newRules: number = 0): boolean {
        if (this.isCloud) {
            return true;
        } else {
            const totalRules = currentRules + newRules;
            return totalRules <= this.MAX_KODY_RULES;
        }
    }

    /**
     * Gets the error message for exceeding the rules limit
     * @param organizationId Organization identifier
     * @returns Error message
     */
    getExceededLimitErrorMessage(organizationId: string): string {
        if (this.isCloud) {
            return '';
        }

        return `Maximum number of Kody Rules (${this.MAX_KODY_RULES}) reached for organization ${organizationId}`;
    }
}
