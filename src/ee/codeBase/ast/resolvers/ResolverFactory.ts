import { LanguageResolver } from '../contracts/LanguageResolver';
import { TypeScriptResolver } from './TypeScriptResolver';
import { JavaScriptResolver } from './JavaScriptResolver';
import { PythonResolver } from './PythonResolver';
import { PhpResolver } from './PhpResolver';
import { RubyResolver } from './RubyResolver';
import { Injectable } from '@nestjs/common';

@Injectable()
export class ResolverFactory {
    private resolvers: LanguageResolver[];

    constructor() {
        // Register all language resolvers here
        this.resolvers = [
            new TypeScriptResolver(),
            new JavaScriptResolver(),
            new PythonResolver(),
            new PhpResolver(),
            new RubyResolver()
        ].sort((a, b) => b.getPriority() - a.getPriority()); // Sort by priority
    }

    async getResolver(projectRoot: string): Promise<LanguageResolver | null> {
        for (const resolver of this.resolvers) {
            if (await resolver.canHandle(projectRoot)) {
                return resolver;
            }
        }
        return null;
    }
}
