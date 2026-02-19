import { getSetupStatus } from "@userbrot/core/services/setupService";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

export const load: PageServerLoad = async (event) => {
  const ownerTelegramId = await resolveOwnerId(event);
  const setup = await getSetupStatus(ownerTelegramId);

  if (setup.status !== "configured") {
    throw redirect(302, "/setup");
  }

  return {};
};
