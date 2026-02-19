import {
  getActiveEmbeddingRun,
  resetChatEmbeddings
} from "@userbrot/core/services/embeddingsService";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

const bodySchema = z.object({
  chatPeerIds: z.array(z.string().regex(/^\d+$/)).min(1).max(1000)
});

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = await resolveOwnerId(event);
    const activeRun = await getActiveEmbeddingRun(ownerTelegramId);

    if (activeRun) {
      return json(
        {
          error: `Cannot reset embeddings while run #${activeRun.id} is ${activeRun.status}. Wait for run to finish.`
        },
        { status: 409 }
      );
    }

    const payload = bodySchema.parse(await event.request.json());

    for (const peerId of payload.chatPeerIds) {
      await resetChatEmbeddings(ownerTelegramId, BigInt(peerId));
    }

    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
