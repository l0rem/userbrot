import { getRuntimeOwnerTelegramId } from "@userbrot/core/services/setupService";
import type { RequestEvent } from "@sveltejs/kit";

export async function resolveOwnerId(_event: RequestEvent): Promise<bigint> {
  return getRuntimeOwnerTelegramId();
}
