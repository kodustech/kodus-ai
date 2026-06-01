import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

import type { ManageImportedRulesAction } from '../application/use-cases/manage-imported-kody-rules.use-case';

export class ManageImportedKodyRulesDto {
    @ApiProperty({
        description: 'Repository whose imported (auto-synced) rules to manage',
    })
    @IsString()
    repositoryId: string;

    @ApiProperty({
        enum: ['pause', 'resume', 'delete'],
        description:
            'pause → ACTIVE rules become PAUSED (skipped by enforcement, kept visible). ' +
            'resume → PAUSED rules become ACTIVE again. ' +
            'delete → ACTIVE/PAUSED rules become DELETED (hidden from list, kept for audit).',
    })
    @IsIn(['pause', 'resume', 'delete'])
    action: ManageImportedRulesAction;
}
