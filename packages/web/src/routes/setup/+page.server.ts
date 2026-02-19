import { getEnv } from "@userbrot/core/env";
import { getSetupStatus } from "@userbrot/core/services/setupService";
import type { PageServerLoad } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

export const load: PageServerLoad = async (event) => {
  const env = getEnv();
  const ownerTelegramId = await resolveOwnerId(event);
  const initialSetup = await getSetupStatus(ownerTelegramId);

  return {
    defaultPhone: env.SETUP_PHONE ?? null,
    initialSetup
  };
};
