import { BadRequestException } from '@nestjs/common';

import { MCPIntegrationAuthType } from '../../integrations/enums/integration.enum';
import { ManagedTokenCredential } from '../../integrations/managed-credential.types';
import { ManagedAuthMethod } from './auth-methods';

export interface TokenSubmission {
    secret?: string;
    fields?: Record<string, string>;
}

/**
 * Validate a user's bring-your-own-token submission against the selected auth
 * method and build the {@link ManagedTokenCredential} to persist.
 *
 * - Rejects OAuth/none methods (they don't take a submitted secret).
 * - Requires the secret (the lone `secret: true` user field).
 * - Requires every other `required` user field, pulled from `submission.fields`.
 *
 * Throws {@link BadRequestException} on any missing/invalid input.
 */
export function validateTokenSubmission(
    method: ManagedAuthMethod,
    submission: TokenSubmission,
): ManagedTokenCredential {
    if (
        method.type === MCPIntegrationAuthType.OAUTH2 ||
        method.type === MCPIntegrationAuthType.NONE
    ) {
        throw new BadRequestException(
            `Auth method "${method.id}" does not accept a submitted token`,
        );
    }

    if (!submission.secret) {
        const secretName =
            method.userFields?.find((f) => f.secret)?.name ?? 'secret';
        throw new BadRequestException(`Missing required field: ${secretName}`);
    }

    const submittedFields = submission.fields ?? {};
    const fields: Record<string, string> = {};
    const missing: string[] = [];

    for (const field of method.userFields ?? []) {
        if (field.secret) {
            continue;
        }

        const value = submittedFields[field.name];
        if (value === undefined || value === '') {
            if (field.required) {
                missing.push(field.name);
            }
            continue;
        }

        fields[field.name] = value;
    }

    if (missing.length > 0) {
        throw new BadRequestException(
            `Missing required field(s): ${missing.join(', ')}`,
        );
    }

    return {
        authMethodId: method.id,
        authType: method.type,
        secret: submission.secret,
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
}
