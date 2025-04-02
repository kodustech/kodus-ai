export interface AliasConfig {
    // The original pattern from the language config (e.g. "@/*" in tsconfig)
    pattern: string;
    // The target path this alias points to (e.g. "./src/*")
    target: string;
}

export interface LanguageResolver {
    /**
     * Check if this resolver can handle the project at the given root
     * For example, TypeScript resolver would check for tsconfig.json
     */
    canHandle(projectRoot: string): Promise<boolean>;

    /**
     * Read and parse the alias configuration for this language
     * Returns a map of alias pattern to target path
     */
    readAliasConfig(projectRoot: string): Promise<Record<string, AliasConfig>>;

    /**
     * Get the priority of this resolver
     * Higher priority resolvers are checked first
     * For example, TypeScript might be higher priority than JavaScript
     */
    getPriority(): number;

    /**
     * Check if a module is external
     */
    isExternalModule(importPath: string): boolean;

    /**
     * Resolve a module path to its absolute path
     */
    resolveModulePath(importPath: string, fromFile: string): Promise<string>;

    /**
     * Get the directories where modules can be found
     */
    getModuleDirectories(): string[];

    /**
     * Get the alias mappings
     */
    getAliasMap(): Record<string, string>;
} 