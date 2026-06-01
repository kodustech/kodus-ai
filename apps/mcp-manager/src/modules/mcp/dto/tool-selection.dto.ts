import { IsArray, IsString, IsNotEmpty } from 'class-validator';

export class GetAvailableToolsDto {
    @IsString()
    @IsNotEmpty()
    integrationId: string;

    @IsString()
    @IsNotEmpty()
    provider: string;
}

export class GetSelectedToolsDto {
    @IsString()
    @IsNotEmpty()
    integrationId: string;

    @IsString()
    @IsNotEmpty()
    provider: string;
}

export class UpdateSelectedToolsDto {
    @IsString()
    @IsNotEmpty()
    integrationId: string;

    @IsString()
    @IsNotEmpty()
    provider: string;

    @IsArray()
    @IsString({ each: true })
    selectedTools: string[];
}

export class ToolSelectionResponseDto {
    success: boolean;
    message?: string;
    data?: any;
    count?: number;
}
