import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class SkillRequiredMcpDto {
    @ApiProperty({ example: 'task-management' })
    category: string;

    @ApiProperty({ example: 'Task Management' })
    label: string;

    @ApiProperty({ example: 'Jira, Linear, Notion', required: false })
    examples?: string;
}

export class SkillMetaDto {
    @ApiProperty({ required: false, example: 'business-rules-validation' })
    name?: string;

    @ApiProperty({ required: false })
    description?: string;

    @ApiProperty({ required: false, example: '1.0.0' })
    version?: string;

    @ApiProperty({ type: [String], required: false })
    allowedTools?: string[];

    @ApiProperty({
        type: [String],
        required: false,
        description:
            'Abstract capabilities declared by the skill (e.g., pr.diff.read, task.context.read).',
    })
    capabilities?: string[];

    @ApiProperty({ type: [SkillRequiredMcpDto], required: false })
    requiredMcps?: SkillRequiredMcpDto[];
}

export class SkillMetaResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: SkillMetaDto })
    data: SkillMetaDto;
}

export class SkillInstructionsDto {
    @ApiProperty({
        description: 'Compiled instructions from SKILL.md + references.',
    })
    instructions: string;
}

export class SkillInstructionsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: SkillInstructionsDto })
    data: SkillInstructionsDto;
}
