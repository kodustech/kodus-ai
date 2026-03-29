import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CliValidateKeyEntityDto {
    @ApiProperty({ nullable: true })
    id: string | null;

    @ApiProperty()
    name: string;
}

export class CliValidateKeyUserDto {
    @ApiProperty()
    email: string;

    @ApiProperty()
    name: string;
}

export class CliValidateKeyPayloadDto {
    @ApiProperty()
    valid: boolean;

    @ApiProperty({ nullable: true })
    teamId: string | null;

    @ApiProperty({ nullable: true })
    organizationId: string | null;

    @ApiProperty()
    teamName: string;

    @ApiProperty()
    organizationName: string;

    @ApiProperty({ type: CliValidateKeyEntityDto })
    team: CliValidateKeyEntityDto;

    @ApiProperty({ type: CliValidateKeyEntityDto })
    organization: CliValidateKeyEntityDto;

    @ApiProperty({ type: CliValidateKeyUserDto })
    user: CliValidateKeyUserDto;

    @ApiProperty()
    email: string;

    @ApiProperty()
    userEmail: string;

    @ApiPropertyOptional()
    error?: string;
}

export class CliValidateKeyResponseDto extends CliValidateKeyPayloadDto {
    @ApiProperty({ type: CliValidateKeyPayloadDto })
    data: CliValidateKeyPayloadDto;
}

export class CliReviewIssueFixRangeDto {
    @ApiProperty({ type: Number })
    start: number;

    @ApiProperty({ type: Number })
    end: number;
}

export class CliReviewIssueFixDto {
    @ApiProperty({ type: CliReviewIssueFixRangeDto })
    range: CliReviewIssueFixRangeDto;

    @ApiProperty()
    replacement: string;
}

export class CliReviewIssueDto {
    @ApiProperty()
    file: string;

    @ApiProperty({ type: Number })
    line: number;

    @ApiPropertyOptional({ type: Number })
    endLine?: number;

    @ApiProperty()
    severity: string;

    @ApiPropertyOptional()
    category?: string;

    @ApiProperty()
    message: string;

    @ApiPropertyOptional()
    suggestion?: string;

    @ApiPropertyOptional()
    recommendation?: string;

    @ApiPropertyOptional()
    ruleId?: string;

    @ApiPropertyOptional({ type: Boolean })
    fixable?: boolean;

    @ApiPropertyOptional({ type: CliReviewIssueFixDto })
    fix?: CliReviewIssueFixDto;
}

export class CliReviewResponseDto {
    @ApiProperty()
    summary: string;

    @ApiProperty({ type: CliReviewIssueDto, isArray: true })
    issues: CliReviewIssueDto[];

    @ApiProperty({ type: Number })
    filesAnalyzed: number;

    @ApiProperty({ type: Number })
    duration: number;
}

export class CliReviewRateLimitDto {
    @ApiProperty({ type: Number })
    remaining: number;

    @ApiProperty({ type: Number })
    limit: number;

    @ApiPropertyOptional()
    resetAt?: string;
}

export class TrialCliReviewResponseDto extends CliReviewResponseDto {
    @ApiPropertyOptional({ type: CliReviewRateLimitDto })
    rateLimit?: CliReviewRateLimitDto;
}

export class CliReviewRateLimitErrorDto {
    @ApiProperty()
    message: string;

    @ApiProperty({ type: Number })
    remaining: number;

    @ApiPropertyOptional()
    resetAt?: string;

    @ApiProperty({ type: Number })
    limit: number;
}

export class CliBusinessValidationResponseDto {
    @ApiProperty({ type: Boolean, example: true })
    accepted: boolean;

    @ApiProperty({
        enum: ['pull_request', 'local_diff'],
        example: 'pull_request',
    })
    mode: 'pull_request' | 'local_diff';

    @ApiProperty({
        example:
            '@kody -v business-logic https://linear.app/kodus/issue/KD-1234/validar-regra',
    })
    command: string;

    @ApiPropertyOptional({ type: Number, example: 123 })
    prNumber?: number;

    @ApiPropertyOptional({
        example: 'https://github.com/kodus-ai/kodus-ai/pull/123',
    })
    prUrl?: string;

    @ApiPropertyOptional({ example: '123456789' })
    repositoryId?: string;

    @ApiPropertyOptional({ example: 'kodus-ai' })
    repositoryName?: string;

    @ApiPropertyOptional({ example: 'KD-1234' })
    taskReference?: string;

    @ApiProperty({
        description:
            'Business validation result returned by the business rules provider.',
        example:
            '## Business Rules Validation\n\nI found 1 potential gap between implementation and acceptance criteria...',
    })
    result: string;
}
