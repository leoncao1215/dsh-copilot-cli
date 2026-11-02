import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { PROVIDER, type Runtime } from "./runtime.js";

export class CopilotCatalog extends LlmAdapter {
  constructor(private readonly runtime: Runtime) {
    super();
  }

  override providerInfo() {
    return { id: PROVIDER, name: "GitHub Copilot CLI" };
  }

  override async listModels(): Promise<LlmModelInfo[]> {
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
          inputModalities: ["text" as const],
        })),
    ];
  }

  override async *stream(
    _options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    throw new Error(
      "The Copilot catalog is not an LLM proxy; use the Copilot agent driver",
    );
  }
}
