import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { ExecuteTeamArtifactsUseCase } from '../../teamArtifacts/execute-teamArtifacts';
import { Injectable } from '@nestjs/common';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';

@Injectable()
export class GenerateCodeArtifactsUseCase implements IUseCase {
    constructor(
        private readonly teamArtifactsUseCase: ExecuteTeamArtifactsUseCase,
    ) {}

    public async execute(organizationAndTeamData: {
        organizationId: string;
        teamId: string;
    }) {
        await this.teamArtifactsUseCase.execute({
            teamId: organizationAndTeamData.teamId,
            organizationId: organizationAndTeamData.organizationId,
            type: 'weekly',
            artifactsToolType: ArtifactsToolType.CODE_MANAGEMENT,
        });
    }
}
