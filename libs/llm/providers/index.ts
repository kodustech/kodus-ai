/**
 * Provider registry barrel. Importing this module registers every provider
 * via side effect, so `REGISTRY.get(<id>)` resolves for all eleven BYOKProvider
 * ids. Add-a-provider = create a `./<provider>/` folder (index.ts self-registers)
 * and add its `import './<provider>'` line here.
 *
 * The 9 provider folders cover the 11 ids: openai (+openai_compatible),
 * anthropic (+anthropic_compatible), google-gemini, vertex (google_vertex,
 * incl. Claude-on-Vertex), openrouter, bedrock, novita, moonshot, azure. Shared
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
import './azure';

export { REGISTRY, registerProvider } from './kernel/registry';
export type { ProviderModule } from './kernel/types';
