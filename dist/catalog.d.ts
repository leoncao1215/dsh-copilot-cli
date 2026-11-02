import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { type Runtime } from "./runtime.js";
export declare class CopilotCatalog extends LlmAdapter {
    private readonly runtime;
    constructor(runtime: Runtime);
    providerInfo(): {
        id: string;
        name: string;
    };
    listModels(): Promise<LlmModelInfo[]>;
    stream(_options: GenerateOptions): AsyncIterable<StreamChunk>;
}
