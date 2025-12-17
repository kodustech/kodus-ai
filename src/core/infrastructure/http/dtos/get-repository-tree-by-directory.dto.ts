import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class GetRepositoryTreeByDirectoryDto {
    @IsString()
    teamId: string;

    @IsString()
    repositoryId: string;

    /**
     * Path do diretório a ser carregado
     * Se não fornecido, carrega a raiz
     * @example "src"
     * @example "src/services"
     */
    @IsOptional()
    @IsString()
    directoryPath?: string;

    /**
     * Se deve usar cache ou buscar dados atualizados
     * @default true
     */
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    })
    useCache?: boolean = true;
}
