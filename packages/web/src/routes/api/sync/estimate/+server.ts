import { loadSyncCheckpoint, setTargetEstimate } from "@userbrot/core/services/syncService";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";
import { estimateChatBackfill } from "$lib/server/syncGateway";

const bodySchema = z.object({
  chatPeerIds: z.array(z.string().regex(/^\d+$/)).min(1).max(5)
});

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = resolveOwnerId(event);
    const payload = bodySchema.parse(await event.request.json());

    const results: Array<{
      peerId: string;
      estimatedMessages: number | null;
      estimatedEtaSeconds: number | null;
      estimateMode: "exact" | "lower_bound" | "unknown";
    }> = [];

    for (const peerId of payload.chatPeerIds) {
      const chatPeerId = BigInt(peerId);
      try {
        const checkpoint = await loadSyncCheckpoint(ownerTelegramId, chatPeerId);
        const estimate = await estimateChatBackfill(ownerTelegramId, chatPeerId, checkpoint.oldestMessageId);

        await setTargetEstimate(ownerTelegramId, chatPeerId, {
          estimatedMessages: estimate.estimatedMessages,
          estimatedEtaSeconds: estimate.estimatedEtaSeconds
        });

        results.push({
          peerId,
          estimatedMessages: estimate.estimatedMessages,
          estimatedEtaSeconds: estimate.estimatedEtaSeconds,
          estimateMode: estimate.estimateMode
        });
      } catch {
        await setTargetEstimate(ownerTelegramId, chatPeerId, {
          estimatedMessages: null,
          estimatedEtaSeconds: null
        });

        results.push({
          peerId,
          estimatedMessages: null,
          estimatedEtaSeconds: null,
          estimateMode: "unknown"
        });
      }
    }

    return json({ estimates: results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
