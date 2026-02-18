import { getOwnerTelegramId } from "@userbrot/core/env";
import type { RequestEvent } from "@sveltejs/kit";

export function resolveOwnerId(event: RequestEvent): bigint {
  const fixedOwner = getOwnerTelegramId();
  if (fixedOwner) {
    return fixedOwner;
  }

  const userIdHeader = event.request.headers.get("x-telegram-user-id");
  if (userIdHeader && /^\d+$/.test(userIdHeader)) {
    return BigInt(userIdHeader);
  }

  return 1n;
}
