/**
 * Provider registry barrel (Phase 1). Importing this module registers every
 * provider module via side effect, so `REGISTRY.get(<id>)` resolves for all
 * nine BYOKProvider ids. Add-a-provider = add its `import './x.module'` line.
 *
 * The 7 module files cover the 9 ids: openai (+openai_compatible),
 * anthropic (+anthropic_compatible), google-gemini, vertex (google_vertex,
 * incl. Claude-on-Vertex), openrouter, bedrock, novita.
 */
import './openai.module';
import './anthropic.module';
import './google-gemini.module';
import './vertex.module';
import './openrouter.module';
import './bedrock.module';
import './novita.module';

export { REGISTRY, registerProvider } from './registry';
export type { ProviderModule } from './types';
