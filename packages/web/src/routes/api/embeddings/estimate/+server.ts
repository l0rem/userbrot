import { requireEmbeddingProviderConfig } from "@userbrot/core/env";
import {
  countPendingEmbeddingsForChat,
  setEmbeddingTargetEstimate
} from "@userbrot/core/services/embeddingsService";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

const MAX_CHAT_SELECTION = 1000;

const bodySchema = z.object({
  chatPeerIds: z.array(z.string().regex(/^\d+$/)).min(1).max(MAX_CHAT_SELECTION)
});

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = await resolveOwnerId(event);
    const payload = bodySchema.parse(await event.request.json());
    const model = requireEmbeddingProviderConfig().model;

    const estimates: Array<{
      peerId: string;
      estimatedMessages: number | null;
      estimatedEtaSeconds: number | null;
      estimateMode: "exact" | "unknown";
    }> = [];

    for (const peerId of payload.chatPeerIds) {
      const chatPeerId = BigInt(peerId);

      try {
        const estimatedMessages = await countPendingEmbeddingsForChat(ownerTelegramId, chatPeerId, model);
        await setEmbeddingTargetEstimate(ownerTelegramId, chatPeerId, {
          estimatedMessages,
          estimatedEtaSeconds: null
        });

        estimates.push({
          peerId,
          estimatedMessages,
          estimatedEtaSeconds: null,
          estimateMode: "exact"
        });
      } catch {
        await setEmbeddingTargetEstimate(ownerTelegramId, chatPeerId, {
          estimatedMessages: null,
          estimatedEtaSeconds: null
        });

        estimates.push({
          peerId,
          estimatedMessages: null,
          estimatedEtaSeconds: null,
          estimateMode: "unknown"
        });
      }
    }

    return json({ estimates });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Select between 1 and ${MAX_CHAT_SELECTION} chats to estimate embeddings`
        : error instanceof Error
          ? error.message
          : String(error);
    return json({ error: message }, { status: 400 });
  }
};
