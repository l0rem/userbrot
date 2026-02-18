import { enqueueSyncRun } from "@userbrot/core/services/syncService";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

const bodySchema = z.object({
  chatPeerIds: z.array(z.string().regex(/^\d+$/)).min(1).max(100)
});

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = resolveOwnerId(event);
    const payload = bodySchema.parse(await event.request.json());
    const chatPeerIds = payload.chatPeerIds.map((value) => BigInt(value));

    const run = await enqueueSyncRun(ownerTelegramId, chatPeerIds);

    return json({
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
