import { clearSyncData, getActiveSyncRun } from "@userbrot/core/services/syncService";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = resolveOwnerId(event);
    const activeRun = await getActiveSyncRun(ownerTelegramId);

    if (activeRun) {
      return json(
        {
          error: `Cannot clear sync data while run #${activeRun.id} is ${activeRun.status}. Stop worker and wait for run to finish.`
        },
        { status: 409 }
      );
    }

    await clearSyncData(ownerTelegramId);
    return json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
