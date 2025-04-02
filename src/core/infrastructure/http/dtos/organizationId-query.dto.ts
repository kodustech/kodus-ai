import { IsString } from "class-validator";

export class OrganizationQueryDto {
    @IsString()
    readonly organizationId: string;
}
