import { requireEmbeddingProviderConfig } from "@userbrot/core/env";
import { enqueueEmbeddingRun } from "@userbrot/core/services/embeddingsService";
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
    const chatPeerIds = payload.chatPeerIds.map((value) => BigInt(value));

    const run = await enqueueEmbeddingRun(ownerTelegramId, chatPeerIds, model);

    return json({
      run: {
        ...run,
        ownerTelegramId: run.ownerTelegramId.toString(),
        chatPeerIds: run.chatPeerIds.map((value) => value.toString()),
        currentChatPeerId: run.currentChatPeerId ? run.currentChatPeerId.toString() : null
      }
    });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Select between 1 and ${MAX_CHAT_SELECTION} chats to start embeddings`
        : error instanceof Error
          ? error.message
          : String(error);
    return json({ error: message }, { status: 400 });
  }
};
