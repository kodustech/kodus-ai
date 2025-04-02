import { Controller, Post, Body, StreamableFile, Res } from '@nestjs/common';
import { AnalyzeDependenciesUseCase } from '@/core/application/use-cases/codeBase/analyze-dependencies.use-case';
import { Response } from 'express';
import { writeFileSync, createReadStream, unlink } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AnalyzeCodeChangesUseCase } from '@/core/application/use-cases/codeBase/analyze-code.use-case';

@Controller('code-base')
export class CodeBaseController {
    constructor(
        private readonly analyzeDependenciesUseCase: AnalyzeDependenciesUseCase,
        private readonly analyzeCodeChangesUseCase: AnalyzeCodeChangesUseCase,
    ) { }

    @Post('analyze-dependencies')
    async analyzeDependencies(
        @Body() body: { entryFile: string; baseDir: string },
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile> {
        // Executa o processo de análise de dependências
        const result = await this.analyzeDependenciesUseCase.execute(
            body.entryFile,
            body.baseDir,
        );

        // Converte o resultado para JSON
        const jsonString = JSON.stringify(result);

        // Gera um caminho de arquivo temporário
        const tempFilePath = join(__dirname, `temp-${uuidv4()}.json`);
        writeFileSync(tempFilePath, jsonString);

        // Define os cabeçalhos para a resposta
        res.set({
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="dependencies.json"',
        });

        // Cria um stream de leitura do arquivo temporário
        const fileStream = createReadStream(tempFilePath);

        // Após o stream ser fechado, deleta o arquivo temporário
        fileStream.on('close', () => {
            unlink(tempFilePath, (err) => {
                if (err) {
                    console.error('Erro ao deletar arquivo temporário:', err);
                }
            });
        });

        return new StreamableFile(fileStream);
    }

    @Post('analyze-code-changes')
    async analyzeCodeChanges(
        @Body()
        body: {
            codeChunk: string;
            fileName: string;
        },
    ) {
        return await this.analyzeCodeChangesUseCase.execute(
            body.codeChunk,
            body.fileName,
        );
    }
}
