import { listEmbeddingCatalogChats } from "@userbrot/core/services/embeddingsService";
import { requireEmbeddingProviderConfig } from "@userbrot/core/env";
import { upsertDiscoveredPrivateChats } from "@userbrot/core/services/syncService";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveOwnerId } from "$lib/server/setupContext";
import { fetchPrivateDialogsCatalog } from "$lib/server/syncGateway";

export const GET: RequestHandler = async (event) => {
  try {
    const ownerTelegramId = await resolveOwnerId(event);
    const snapshot = await fetchPrivateDialogsCatalog(ownerTelegramId);
    await upsertDiscoveredPrivateChats(ownerTelegramId, snapshot.chats);

    const model = requireEmbeddingProviderConfig().model;
    const chats = await listEmbeddingCatalogChats(ownerTelegramId, model);
    const metadataByPeerId = new Map(snapshot.chats.map((chat) => [chat.peerId.toString(), chat]));

    return json({
      model,
      folders: snapshot.folders,
      chats: chats
        .filter((chat) => metadataByPeerId.has(chat.peerId.toString()))
        .map((chat) => {
          const metadata = metadataByPeerId.get(chat.peerId.toString());
          return {
            ...chat,
            peerId: chat.peerId.toString(),
            isPinned: metadata?.isPinned ?? false,
            avatarUrl: metadata?.avatarUrl ?? null
          };
        })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 400 });
  }
};
