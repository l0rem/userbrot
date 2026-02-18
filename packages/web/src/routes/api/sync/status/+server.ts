import { getSyncStatusSnapshot, listSyncCatalogChats } from "@userbrot/core/services/syncService";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";

export const GET: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = resolveOwnerId(event);
    const snapshot = await getSyncStatusSnapshot(ownerTelegramId);
    const chats = await listSyncCatalogChats(ownerTelegramId);

    return json({
      activeRun: snapshot.activeRun
        ? {
            ...snapshot.activeRun,
            ownerTelegramId: snapshot.activeRun.ownerTelegramId.toString(),
            chatPeerIds: snapshot.activeRun.chatPeerIds.map((value) => value.toString()),
            currentChatPeerId: snapshot.activeRun.currentChatPeerId
              ? snapshot.activeRun.currentChatPeerId.toString()
              : null
          }
        : null,
      latestRun: snapshot.latestRun
        ? {
            ...snapshot.latestRun,
            ownerTelegramId: snapshot.latestRun.ownerTelegramId.toString(),
            chatPeerIds: snapshot.latestRun.chatPeerIds.map((value) => value.toString()),
            currentChatPeerId: snapshot.latestRun.currentChatPeerId
              ? snapshot.latestRun.currentChatPeerId.toString()
              : null
          }
        : null,
      logs: snapshot.logs,
      chats: chats.map((chat) => ({
        ...chat,
        peerId: chat.peerId.toString()
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
