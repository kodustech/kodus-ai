import { SupportedLanguage } from '@/core/domain/codeBase/contracts/SupportedLanguages';

/**
 * Import configuration provider for a specific language
 */
export interface ImportConfigProvider {
    /**
     * Checks if this provider can handle the file/project type
     */
    canHandle(filePath: string): Promise<boolean>;

    /**
     * Determines if an import is external or not
     */
    isExternalModule(importPath: string): boolean;

    /**
     * Resolves an import path to an absolute path
     */
    resolveModulePath(importPath: string, fromFile: string): Promise<string>;

    /**
     * Returns the base directories where modules can be found
     */
    getModuleDirectories(): string[];

    /**
     * Returns the alias -> real path mappings
     */
    getAliasMap(): Record<string, string>;
}

/**
 * Represents a resolved import path with additional metadata
 */
export interface ResolvedImport {
    /**
     * The original import path as written in the code
     */
    originalPath: string;

    /**
     * The normalized absolute path within the project
     * This is used as the unique identifier for the file in the graph
     */
    normalizedPath: string;

    /**
     * The relative path from the project root
     * This is used for display and debugging purposes
     */
    relativePath: string;

    /**
     * Whether this is an external module (e.g. from node_modules)
     */
    isExternal: boolean;

    /**
     * The language of the imported file (if known)
     */
    language?: SupportedLanguage;

    /**
     * Any aliases used in the import (e.g. @ for src)
     */
    usedAlias?: string;
}

/**
 * Service responsible for resolving and normalizing import paths
 */
export interface IImportPathResolver {
    /**
     * Initialize the resolver
     * @param rootDir The root directory of the project
     * @param configProvider The provider that knows how to handle imports for this project type
     */
    initialize(rootDir: string, configProvider: ImportConfigProvider): void;

    /**
     * Resolve an import path to its normalized form
     * @param importPath The original import path
     * @param currentFile The file containing the import
     */
    resolveImport(
        importPath: string,
        currentFile: string,
    ): Promise<ResolvedImport>;

    /**
     * Get the normalized path for a file
     * This is used to ensure consistent file identification across the graph
     * @param filePath Any form of the file path (absolute, relative, with aliases)
     */
    getNormalizedPath(filePath: string): string;

    /**
     * Check if a path represents an external module
     * @param importPath The import path to check
     */
    isExternalModule(importPath: string): boolean;

    /**
     * Get the relative path from the project root
     * @param absolutePath The absolute path to convert
     */
    getRelativePath(absolutePath: string): string;
}
