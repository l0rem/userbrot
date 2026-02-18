import { startSetup } from "@userbrot/core/services/setupService";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { setupGateway } from "$lib/server/mtprotoGateway";
import { resolveOwnerId } from "$lib/server/setupContext";

const bodySchema = z.object({
  phone: z.string().trim().min(7).max(32)
});

export const POST: RequestHandler = async (event) => {
  try {
    const payload = bodySchema.parse(await event.request.json());
    const ownerTelegramId = resolveOwnerId(event);
    const result = await startSetup(ownerTelegramId, payload.phone, setupGateway);
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
