import { OrganizationAndTeamDataDto } from '@/core/infrastructure/http/dtos/organizationAndTeamData.dto';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';

export class InteractionDto {
    // Type of interaction
    @IsIn(['button', 'chat', 'command'])
    interactionType: 'button' | 'chat' | 'command';

    // For commands, the name of the typed command will be passed...
    // For Buttons, the name of the button category will be passed...
    @IsString()
    interactionCommand: string;

    // Text of the button that interacted with the platform in question...
    // ONLY OCCURS IN BUTTON INTERACTIONS
    @IsOptional()
    @IsString()
    buttonLabel?: string; // Button text for button interactions

    // ID of the user who interacted with the platform in question...
    @IsString()
    platformUserId: string;

    @ValidateNested() // Indicates that the property is an object that must also be validated
    @Type(() => OrganizationAndTeamDataDto) // Ensures the object is transformed to the correct type
    organizationAndTeamData: OrganizationAndTeamDataDto;
}
