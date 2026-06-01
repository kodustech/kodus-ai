import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class RuleIdsDto {
    @IsOptional()
    @IsString()
    @ApiProperty({
        type: String,
        required: false,
        example: 'team_123',
    })
    teamId?: string;

    @IsArray()
    @IsString({ each: true })
    @ApiProperty({
        type: String,
        isArray: true,
        example: ['rule_123', 'rule_456'],
    })
    ruleIds: string[];
}
