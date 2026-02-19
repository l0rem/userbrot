import type { ConversationStateType } from "../state";
import { messageRepo } from "@userbrot/core";

export async function persistResponseNode(
  state: ConversationStateType
): Promise<Partial<ConversationStateType>> {
  if (!state.assistantOutput) {
    return { error: "No assistant output to persist" };
  }

  await messageRepo.add(state.conversationId, "assistant", state.assistantOutput, {
    modelName: state.modelName ?? undefined,
    inputTokens: state.inputTokens ?? undefined,
    outputTokens: state.outputTokens ?? undefined
  });

  return {
    finishedAt: Date.now()
  };
}
