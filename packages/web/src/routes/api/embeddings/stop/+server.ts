import {
  appendEmbeddingRunLog,
  cancelActiveEmbeddingRun
} from "@userbrot/core/services/embeddingsService";
import { json, type RequestHandler } from "@sveltejs/kit";
import { resolveOwnerId } from "$lib/server/setupContext";

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = await resolveOwnerId(event);
    const run = await cancelActiveEmbeddingRun(ownerTelegramId);

    if (!run) {
      return json({ stopped: false, run: null });
    }

    await appendEmbeddingRunLog(run.id, ownerTelegramId, "Embedding run stopped by user", "warn");

    return json({
      stopped: true,
      run: {
        ...run,
        ownerTelegramId: run.ownerTelegramId.toString(),
        chatPeerIds: run.chatPeerIds.map((value) => value.toString()),
        currentChatPeerId: run.currentChatPeerId ? run.currentChatPeerId.toString() : null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
