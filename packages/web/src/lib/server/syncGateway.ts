import { countStoredChatMessages, db, requireMtprotoApiCredentials } from "@userbrot/core";
import { Dialog, MemoryStorage, TelegramClient } from "@mtcute/node";
import type { tl } from "@mtcute/node";

export type SyncFolder = {
  id: number;
  title: string;
  kind: "all" | "custom";
};

export type PrivateDialogCatalogItem = {
  peerId: bigint;
  title: string;
  username: string | null;
  isBot: boolean;
  isPinned: boolean;
  avatarUrl: string | null;
  folderIds: number[];
  lastMessageId: number | null;
  lastMessageDate: Date | null;
};

export type SyncCatalogSnapshot = {
  folders: SyncFolder[];
  chats: PrivateDialogCatalogItem[];
};

export type BackfillEstimateMode = "exact" | "lower_bound" | "unknown";

export type BackfillEstimate = {
  estimatedMessages: number | null;
  estimatedEtaSeconds: number | null;
  estimateMode: BackfillEstimateMode;
};

type CustomFolder = {
  id: number;
  filter: tl.TypeDialogFilter;
};

function parseFolderTitle(filter: tl.TypeDialogFilter): string {
  if (filter._ === "dialogFilterDefault") {
    return "All chats";
  }

  if ((filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist") && filter.title) {
    const title = filter.title;
    if (typeof title === "object" && title !== null && "text" in title) {
      const text = (title as { text?: unknown }).text;
      if (typeof text === "string" && text.trim().length > 0) {
        return text;
      }
    }
  }

  if ("id" in filter && typeof filter.id === "number") {
    return `Folder ${filter.id}`;
  }

  return "Folder";
}

async function withOwnerClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const session = await db.query.mtprotoSessions.findFirst({
    orderBy: (table, operators) => [operators.desc(table.updatedAt)]
  });

  if (!session) {
    throw new Error("No MTProto session found. Complete setup first.");
  }

  const { apiId, apiHash } = requireMtprotoApiCredentials();
  const client = new TelegramClient({
    apiId,
    apiHash,
    storage: new MemoryStorage(),
    disableUpdates: true
  });

  try {
    await client.importSession(session.sessionString, true);
    return await fn(client);
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

function buildAvatarUrl(username: string | null): string | null {
  if (!username) {
    return null;
  }

  return `https://t.me/i/userpic/320/${username}.jpg`;
}

function parseDialogPinned(dialog: unknown): boolean {
  if (typeof dialog !== "object" || dialog === null) {
    return false;
  }

  const maybeDialog = dialog as {
    isPinned?: unknown;
    pinned?: unknown;
  };

  if (typeof maybeDialog.isPinned === "boolean") {
    return maybeDialog.isPinned;
  }

  if (typeof maybeDialog.pinned === "boolean") {
    return maybeDialog.pinned;
  }

  return false;
}

function parsePeerDeleted(peer: unknown): boolean {
  if (typeof peer !== "object" || peer === null) {
    return false;
  }

  const maybePeer = peer as {
    isDeleted?: unknown;
    deleted?: unknown;
  };

  if (typeof maybePeer.isDeleted === "boolean") {
    return maybePeer.isDeleted;
  }

  if (typeof maybePeer.deleted === "boolean") {
    return maybePeer.deleted;
  }

  return false;
}

export async function fetchPrivateDialogsCatalog(_ownerTelegramId: bigint): Promise<SyncCatalogSnapshot> {
  return withOwnerClient(async (client) => {
    const folderResponse = await client.getFolders();
    const customFolders: CustomFolder[] = [];
    const folders: SyncFolder[] = [
      {
        id: 0,
        title: "All chats",
        kind: "all"
      }
    ];

    for (const filter of folderResponse.filters) {
      if (filter._ === "dialogFilterDefault") {
        continue;
      }

      if ("id" in filter && typeof filter.id === "number") {
        customFolders.push({
          id: filter.id,
          filter
        });

        folders.push({
          id: filter.id,
          title: parseFolderTitle(filter),
          kind: "custom"
        });
      }
    }

    const dialogsByPeerId = new Map<string, PrivateDialogCatalogItem>();

    for await (const dialog of client.iterDialogs({
      limit: 1000,
      archived: "keep",
      pinned: "keep"
    })) {
      const peer = dialog.peer;
      if (peer.type !== "user") {
        continue;
      }

      if (peer.isBot || parsePeerDeleted(peer)) {
        continue;
      }

      const peerId = BigInt(peer.id);
      const folderIds = [0];

      for (const folder of customFolders) {
        if (Dialog.filterFolder(folder.filter)(dialog)) {
          folderIds.push(folder.id);
        }
      }

      const item: PrivateDialogCatalogItem = {
        peerId,
        title: peer.displayName,
        username: peer.username ?? null,
        isBot: peer.isBot,
        isPinned: parseDialogPinned(dialog),
        avatarUrl: buildAvatarUrl(peer.username ?? null),
        folderIds,
        lastMessageId: dialog.lastMessage?.id ?? null,
        lastMessageDate: dialog.lastMessage?.date ?? null
      };

      dialogsByPeerId.set(peerId.toString(), item);
    }

    const chats = Array.from(dialogsByPeerId.values()).sort((a, b) => {
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }

      return a.title.localeCompare(b.title);
    });

    return {
      folders,
      chats
    };
  });
}

export async function estimateChatBackfill(
  ownerTelegramId: bigint,
  chatPeerId: bigint,
  _resumeOldestMessageId?: number | null
): Promise<BackfillEstimate> {
  return withOwnerClient(async (client) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const safeGetHistory = async <T>(fn: () => Promise<T>): Promise<T> => {
      let attempt = 0;

      while (attempt < 5) {
        try {
          return await fn();
        } catch (error) {
          if (error instanceof Error) {
            const match = error.message.match(/wait of\s+(\d+)\s+seconds/i);
            if (match) {
              const waitSeconds = Number.parseInt(match[1], 10);
              if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
                await sleep(Math.ceil(waitSeconds * 1000 * 1.1));
                attempt += 1;
                continue;
              }
            }
          }

          throw error;
        }
      }

      throw new Error("Estimate history probe exceeded retry policy");
    };

    const firstPage = await safeGetHistory(() => client.getHistory(Number(chatPeerId), { limit: 1 }));
    if (firstPage.length === 0) {
      return {
        estimatedMessages: 0,
        estimatedEtaSeconds: 0,
        estimateMode: "exact"
      };
    }

    const rawTotal = (firstPage as unknown as { total?: unknown }).total;
    const totalMessages = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null;

    const TELEGRAM_TOTAL_SENTINEL = 2_147_483_647;
    const hasUsableTotal =
      totalMessages !== null &&
      totalMessages < TELEGRAM_TOTAL_SENTINEL &&
      totalMessages <= 1_000_000_000 &&
      totalMessages >= 0;

    if (
      totalMessages === null ||
      totalMessages >= TELEGRAM_TOTAL_SENTINEL ||
      totalMessages > 1_000_000_000 ||
      totalMessages < 0
    ) {
      const anchor = (firstPage[0]?.id ?? 0) + 1;
      const limit = 100;
      const maxProbePages = 12;
      let offset = 0;
      let fetched = 0;
      let reachedEnd = false;

      for (let index = 0; index < maxProbePages; index += 1) {
        const page = await safeGetHistory(() =>
          client.getHistory(Number(chatPeerId), {
            limit,
            offsetId: anchor,
            addOffset: offset
          } as any)
        );

        if (page.length === 0) {
          reachedEnd = true;
          break;
        }

        fetched += page.length;
        offset += page.length;

        if (page.length < limit) {
          reachedEnd = true;
          break;
        }
      }

      const storedCount = await countStoredChatMessages(ownerTelegramId, chatPeerId);
      const estimatedMessages = Math.max(fetched - storedCount, 0);
      const estimateMode: BackfillEstimateMode = reachedEnd ? "exact" : "lower_bound";

      return {
        estimatedMessages,
        estimatedEtaSeconds:
          estimateMode === "exact" ? (estimatedMessages > 0 ? Math.ceil(estimatedMessages / 35) : 0) : null,
        estimateMode
      };
    }

    const storedCount = await countStoredChatMessages(ownerTelegramId, chatPeerId);
    const estimatedMessages = Math.max((hasUsableTotal ? totalMessages : 0) - storedCount, 0);

    return {
      estimatedMessages,
      estimatedEtaSeconds: estimatedMessages > 0 ? Math.ceil(estimatedMessages / 35) : 0,
      estimateMode: "exact"
    };
  });
}
