import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class OrganizationParameterStoredDto {
    @ApiProperty({ format: 'uuid' })
    _uuid: string;

    @ApiProperty()
    _configKey: string;

    @ApiProperty({
        type: Object,
        description: 'Organization parameter value (schema varies by key).',
        additionalProperties: true,
    })
    _configValue: Record<string, unknown>;
}

export class OrganizationParameterStoredResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: OrganizationParameterStoredDto })
    data: OrganizationParameterStoredDto;
}

export class OrganizationProviderDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    description: string;

    @ApiProperty()
    requiresApiKey: boolean;

    @ApiProperty()
    requiresBaseUrl: boolean;

    @ApiProperty()
    autoListModels: boolean;
}

export class OrganizationProvidersDataDto {
    @ApiProperty({ type: OrganizationProviderDto, isArray: true })
    providers: OrganizationProviderDto[];
}

export class OrganizationProvidersResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: OrganizationProvidersDataDto })
    data: OrganizationProvidersDataDto;
}

export class OrganizationProviderModelReasoningDto {
    @ApiProperty()
    type: string;

    @ApiProperty({ type: String, isArray: true })
    options: string[];
}

export class OrganizationProviderModelDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty({ required: false })
    supportsReasoning?: boolean;

    @ApiProperty({
        required: false,
        type: OrganizationProviderModelReasoningDto,
    })
    reasoningConfig?: OrganizationProviderModelReasoningDto;
}

export class OrganizationProviderModelsDataDto {
    @ApiProperty()
    provider: string;

    @ApiProperty({ type: OrganizationProviderModelDto, isArray: true })
    models: OrganizationProviderModelDto[];
}

export class OrganizationProviderModelsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: OrganizationProviderModelsDataDto })
    data: OrganizationProviderModelsDataDto;
}

export class OrganizationMetricsVisibilityResponseDto extends ApiResponseBaseDto {
    @ApiProperty({
        type: Object,
        description: 'Metrics visibility settings (schema varies by tenant).',
        additionalProperties: true,
    })
    data: Record<string, unknown>;
}
