import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class ExecuteRouterDto {
    @IsObject()
    router: any;

    @IsString()
    message: string;

    @IsString()
    userId: string;

    @IsString()
    channel: string;

    @IsString()
    sessionId: string;

    @IsString()
    userName: string;

    @IsUUID()
    @IsOptional()
    teamId?: string;

    @IsUUID()
    @IsOptional()
    organizationId?: string;
}
