import {
  clearEmbeddingData,
  getActiveEmbeddingRun
} from "@userbrot/core/services/embeddingsService";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = await resolveOwnerId(event);
    const activeRun = await getActiveEmbeddingRun(ownerTelegramId);

    if (activeRun) {
      return json(
        {
          error: `Cannot clear embeddings data while run #${activeRun.id} is ${activeRun.status}. Wait for run to finish.`
        },
        { status: 409 }
      );
    }

    await clearEmbeddingData(ownerTelegramId);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
