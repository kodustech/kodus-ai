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
            'The verdict as text: one line per requirement, then the status.',
        example:
            'AB#8 · Compact density toggle (Azure DevOps)\n  MET            AC-1 Persists per user src/settings/density.ts:14\n  MISSING        AC-2 Defaults to comfortable density.ts:6\n\nstatus: issues_found (--json for the full verdict)',
    })
    result: string;

    @ApiProperty({
        description:
            'The same verdict, structured: status, whether the check would pass, and per task the requirements with their state (met, partial, missing, check_manually), evidence and action, plus changes not in the task.',
        example: {
            status: 'issues_found',
            passed: false,
            tasks: [
                {
                    tracker: 'Azure DevOps',
                    id: 'AB#8',
                    title: 'Compact density toggle',
                    readAt: '2026-10-05T12:00:00.000Z',
                    passed: false,
                    requirements: [
                        {
                            requirement: 'Defaults to comfortable',
                            source: 'AC #2',
                            state: 'missing',
                            evidence: [
                                { file: 'src/settings/density.ts', line: 6 },
                            ],
                            note: 'Sets "compact" as the default.',
                            action: 'Change the default to "comfortable".',
                            confidence: 'high',
                        },
                    ],
                    outOfScope: [],
                },
            ],
        },
    })
    verdict: Record<string, unknown>;
}
