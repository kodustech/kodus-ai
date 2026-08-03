/**
 * Provider registry barrel. Importing this module registers every provider
 * via side effect, so `REGISTRY.get(<id>)` resolves for all ten BYOKProvider
 * ids. Add-a-provider = create a `./<provider>/` folder (index.ts self-registers)
 * and add its `import './<provider>'` line here.
 *
 * The 8 provider folders cover the 10 ids: openai (+openai_compatible),
 * anthropic (+anthropic_compatible), google-gemini, vertex (google_vertex,
 * incl. Claude-on-Vertex), openrouter, bedrock, novita, moonshot. Shared
 * kernel (types, registry, capabilities, conformance) lives in ./kernel.
 */
import './openai';
import './anthropic';
import './google-gemini';
import './vertex';
import './openrouter';
import './bedrock';
import './novita';
import './moonshot';

export { REGISTRY, registerProvider } from './kernel/registry';
export type { ProviderModule } from './kernel/types';
