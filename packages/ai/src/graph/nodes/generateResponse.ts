import type { ConversationStateType } from "../state";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { requireLlmProviderConfig, messageRepo } from "@userbrot/core";
import { SYSTEM_PROMPT } from "../../prompts";

export async function generateResponseNode(
  state: ConversationStateType
): Promise<Partial<ConversationStateType>> {
  const llmConfig = requireLlmProviderConfig();

  console.log("[generateResponse] === Node Entry ===");
  console.log("[generateResponse] Model:", llmConfig.model);
  console.log("[generateResponse] state.messages.length:", state.messages.length);
  if (state.messages.length > 0) {
    const types = state.messages.map((m, i) => `${i}: ${(m as any)._getType?.() ?? (m as any).getType?.() ?? typeof m}`);
    console.log("[generateResponse] Message types:", types.join(", "));
  }

  const model = new ChatOpenAI({
    model: llmConfig.model,
    openAIApiKey: llmConfig.apiKey,
    configuration: {
      baseURL: llmConfig.baseUrl
    },
    temperature: 0.7,
    // IMPORTANT: Disable streaming when using tools — many providers
    // (including Gemini via OpenRouter) reject streaming + tool_calls
    streaming: false
  });

  // Bypass tiktoken error for non-OpenAI format models
  model.getNumTokens = async () => 0;

  const { agentTools } = await import("../tools");
  const modelWithTools = model.bindTools(agentTools);

  const systemMessage = new SystemMessage(SYSTEM_PROMPT);

  // Detect tool-loop call: last message is a ToolMessage (result from tool execution)
  const lastMsg = state.messages[state.messages.length - 1];
  const lastMsgType = (lastMsg as any)?._getType?.() ?? (lastMsg as any)?.getType?.() ?? null;
  const isToolLoopCall = lastMsgType === "tool";

  console.log("[generateResponse] lastMsgType:", lastMsgType, "isToolLoopCall:", isToolLoopCall);

  let allMessages;
  if (isToolLoopCall) {
    allMessages = [systemMessage, ...state.messages];
  } else {
    await messageRepo.add(state.conversationId, "user", state.userInput);
    const userMessage = new HumanMessage(state.userInput);
    allMessages = [systemMessage, ...state.messages, userMessage];
  }

  console.log("[generateResponse] Sending", allMessages.length, "messages to LLM");

  const response = await modelWithTools.invoke(allMessages);

  const responseType = (response as any)._getType?.() ?? (response as any).getType?.() ?? typeof response;
  const toolCalls = (response as any).tool_calls ?? [];
  const additionalToolCalls = response.additional_kwargs?.tool_calls ?? [];

  console.log("[generateResponse] Response type:", responseType);
  console.log("[generateResponse] response.tool_calls:", JSON.stringify(toolCalls));
  console.log("[generateResponse] response.additional_kwargs.tool_calls:", JSON.stringify(additionalToolCalls));
  console.log("[generateResponse] response.content:", typeof response.content === "string" ? response.content.slice(0, 200) : JSON.stringify(response.content).slice(0, 200));

  const assistantOutput = response.content.toString();
  const tokenUsage = response.response_metadata?.tokenUsage;

  // With messagesStateReducer, we return ONLY the new messages to append.
  // The reducer automatically merges them into the existing state.messages.
  const newMessages = isToolLoopCall
    ? [response]
    : [new HumanMessage(state.userInput), response];

  console.log("[generateResponse] Returning", newMessages.length, "new messages (reducer will append)");
  console.log("[generateResponse] === Node Exit ===");

  return {
    assistantOutput,
    modelName: llmConfig.model,
    inputTokens: tokenUsage?.promptTokens ?? null,
    outputTokens: tokenUsage?.completionTokens ?? null,
    messages: newMessages
  };
}
