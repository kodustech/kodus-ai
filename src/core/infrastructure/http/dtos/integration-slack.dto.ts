import { IsString } from 'class-validator';

export class IntegrationSlackDto {
    @IsString()
    public code: string;
}
