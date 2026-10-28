import { ChatGPTPlanResponses, ChatGPTPlanResponsesError } from "./chatgpt-plan-responses.js";
import {
  OpenAIClassifierError,
  type OpenAIClassifierResult,
  type PreparedOpenAIRequest,
  validateCategoricalOutput,
} from "./openai-classifier.js";

/**
 * Converts the ChatGPT-plan Responses receipt into the same validated category
 * shape used by the chart, preserving plan accounting as a separate lineage.
 */
export class ChatGPTPlanClassifier {
  constructor(private readonly responses: ChatGPTPlanResponses) {}

  async classifyPrepared(request: PreparedOpenAIRequest): Promise<OpenAIClassifierResult> {
    try {
      const result = await this.responses.classifyPrepared(request);
      let classification: OpenAIClassifierResult["classification"];
      try { classification = validateCategoricalOutput(result.response, request); }
      catch (error) {
        const message = error instanceof Error ? error.message : "ChatGPT response failed Luna classification validation";
        throw new OpenAIClassifierError(
          message, result.httpStatus, false, false, result.responseId, result.responseSha256,
          { ...result.usage, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, estimatedCostUsd: null },
          result.latencyMs, null, result.modelReturned, result.serviceTier, true,
        );
      }
      return {
        classification,
        modelReturned: result.modelReturned,
        serviceTier: result.serviceTier,
        accountingRoute: "chatgpt_plan",
        profileSha256: result.profileSha256,
        responseId: result.responseId,
        responseSha256: result.responseSha256,
        usage: {
          inputTokens: result.usage.inputTokens,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: null,
          totalTokens: result.usage.totalTokens,
          estimatedCostUsd: null,
        },
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
      };
    } catch (error) {
      if (error instanceof OpenAIClassifierError) throw error;
      if (error instanceof ChatGPTPlanResponsesError) {
        throw new OpenAIClassifierError(
          error.message, error.status, error.retryable, error.outcomeUnknown,
          null, null, null, null, error.retryAfterMs, null, null, error.requestDispatched,
          error.providerCode, error.parameter, error.requestId, error.failureKind,
        );
      }
      throw new OpenAIClassifierError("ChatGPT-plan classification failed before a validated result was produced.", null, false, true);
    }
  }
}
