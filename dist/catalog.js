import { LlmAdapter, } from "@deepseek-ai/dsh-llm";
import { PROVIDER } from "./runtime.js";
export class CopilotCatalog extends LlmAdapter {
    runtime;
    constructor(runtime) {
        super();
        this.runtime = runtime;
    }
    providerInfo() {
        return { id: PROVIDER, name: "GitHub Copilot CLI" };
    }
    async listModels() {
        const models = await this.runtime.listModels();
        return [
            {
                provider: PROVIDER,
                id: "auto",
                name: "Copilot Auto",
                inputModalities: ["text"],
            },
            ...models
                .filter((model) => model.id !== "auto")
                .map((model) => ({
                provider: PROVIDER,
                id: model.id,
                name: model.name,
                inputModalities: ["text"],
            })),
        ];
    }
    async *stream(_options) {
        throw new Error("The Copilot catalog is not an LLM proxy; use the Copilot agent driver");
    }
}
