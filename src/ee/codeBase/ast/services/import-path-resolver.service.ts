import { Injectable } from '@nestjs/common';
import * as path from 'path';
import {
    IImportPathResolver,
    ResolvedImport,
    ImportConfigProvider,
} from '../contracts/ImportPathResolver';
import { ResolverFactory } from '../resolvers/ResolverFactory';
import { AliasConfig } from '../contracts/LanguageResolver';

@Injectable()
export class ImportPathResolverService implements IImportPathResolver {
    private rootDir: string;
    private aliases: Record<string, AliasConfig>;
    private configProvider: ImportConfigProvider;

    constructor(private readonly resolverFactory: ResolverFactory) {
        this.aliases = {};
    }

    initialize(rootDir: string, configProvider: ImportConfigProvider): void {
        this.rootDir = path.resolve(rootDir);
        this.configProvider = configProvider;

        // Get alias mappings from config provider
        this.aliases = {};
        const aliasMap = this.configProvider.getAliasMap();
        for (const [pattern, target] of Object.entries(aliasMap)) {
            this.aliases[pattern] = {
                pattern,
                target: path.resolve(this.rootDir, target),
            };
        }
    }

    async resolveImport(
        importPath: string,
        currentFile: string,
    ): Promise<ResolvedImport> {
        try {
            // First try to resolve through the config provider
            const resolvedPath = await this.configProvider.resolveModulePath(
                importPath,
                currentFile,
            );

            const result: ResolvedImport = {
                originalPath: importPath,
                normalizedPath: resolvedPath || importPath,
                relativePath: resolvedPath
                    ? this.getRelativePath(resolvedPath)
                    : importPath,
                isExternal: this.configProvider.isExternalModule(importPath),
            };

            return result;
        } catch (error) {
            console.error(
                `Could not resolve import path: ${importPath} from ${currentFile}`,
                error,
            );
            return {
                originalPath: importPath,
                normalizedPath: importPath,
                relativePath: importPath,
                isExternal: true,
            };
        }
    }

    getNormalizedPath(filePath: string): string {
        // Always convert to absolute path with forward slashes
        return path.resolve(this.rootDir, filePath).replace(/\\/g, '/');
    }

    isExternalModule(importPath: string): boolean {
        return this.configProvider.isExternalModule(importPath);
    }

    getRelativePath(absolutePath: string): string {
        return path.relative(this.rootDir, absolutePath).replace(/\\/g, '/');
    }
}
