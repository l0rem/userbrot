import { getSetupStatus, resetSetup } from "@userbrot/core/services/setupService";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

export const POST: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = await resolveOwnerId(event);
    await resetSetup(ownerTelegramId);
    const status = await getSetupStatus(ownerTelegramId);
    return json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
