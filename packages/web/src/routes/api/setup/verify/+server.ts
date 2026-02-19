import { verifySetupCode } from "@userbrot/core/services/setupService";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { setupGateway } from "$lib/server/mtprotoGateway";
import { resolveOwnerId } from "$lib/server/setupContext";

const bodySchema = z.object({
  code: z.string().trim().min(4).max(12).optional(),
  password: z.string().min(1).max(256).optional()
});

export const POST: RequestHandler = async (event) => {
  try {
    const payload = bodySchema.parse(await event.request.json());
    const ownerTelegramId = await resolveOwnerId(event);
    const result = await verifySetupCode(ownerTelegramId, payload, setupGateway);
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
