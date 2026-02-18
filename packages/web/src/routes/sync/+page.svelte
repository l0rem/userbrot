<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  type Folder = {
    id: number;
    title: string;
    kind: "all" | "custom";
  };

  type Chat = {
    peerId: string;
    title: string;
    username: string | null;
    isBot: boolean;
    isPinned: boolean;
    avatarUrl: string | null;
    folderIds: number[];
    lastMessageId: number | null;
    lastMessageDate: string | null;
    selected: boolean;
    status: "pending" | "syncing" | "synced" | "error";
    isSynced: boolean;
    estimatedMode: "exact" | "lower_bound" | "unknown";
    estimatedMessages: number | null;
    estimatedEtaSeconds: number | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  };

  type Run = {
    id: number;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    totalChats: number;
    completedChats: number;
    estimatedMessages: number;
    processedMessages: number;
    etaSeconds: number | null;
    currentChatPeerId: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
  };

  type RunLog = {
    id: number;
    level: string;
    message: string;
    createdAt: string;
  };

  let folders: Folder[] = [];
  let chats: Chat[] = [];
  let activeFolderId = 0;
  let selectedPeerIds = new Set<string>();
  let activeRun: Run | null = null;
  let latestRun: Run | null = null;
  let logs: RunLog[] = [];
  let hiddenAvatarPeerIds = new Set<string>();
  let busyCatalog = false;
  let busyEstimate = false;
  let busyStart = false;
  let busyDebugClear = false;
  let uiError = "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const statusLabel: Record<Chat["status"], string> = {
    pending: "Unsynced",
    syncing: "Syncing",
    synced: "✓ Synced",
    error: "Error"
  };

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? `Request failed with ${response.status}`);
    }

    return payload;
  }

  function formatSeconds(value: number | null): string {
    if (value === null || value <= 0) {
      return "-";
    }

    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

  function compactText(value: string, max = 260): string {
    if (value.length <= max) {
      return value;
    }

    return `${value.slice(0, max - 3)}...`;
  }

  function formatChatEstimate(chat: Chat): string | null {
    if (chat.estimatedMessages === null) {
      return null;
    }

    return chat.estimatedMode === "lower_bound" ? `${chat.estimatedMessages}+ msgs` : `${chat.estimatedMessages} msgs`;
  }

  function shouldShowChatEta(chat: Chat): boolean {
    if (chat.status === "synced") {
      return false;
    }

    return chat.estimatedMode === "exact" && chat.estimatedEtaSeconds !== null;
  }

  function applySelectionFromChats(items: Chat[]) {
    selectedPeerIds = new Set(items.filter((chat) => chat.selected).map((chat) => chat.peerId));
  }

  function mergeStatusChats(nextChats: Chat[]): Chat[] {
    const existingByPeerId = new Map(chats.map((chat) => [chat.peerId, chat]));

    return nextChats.map((chat) => {
      const existing = existingByPeerId.get(chat.peerId);

      return {
        ...chat,
        isPinned: existing?.isPinned ?? false,
        avatarUrl: existing?.avatarUrl ?? null
      };
    });
  }

  async function loadCatalog() {
    busyCatalog = true;
    uiError = "";

    try {
      const payload = await request<{ folders: Folder[]; chats: Chat[] }>("/api/sync/catalog");
      folders = payload.folders;
      chats = payload.chats;
      hiddenAvatarPeerIds = new Set();
      applySelectionFromChats(payload.chats);

      if (!folders.some((folder) => folder.id === activeFolderId)) {
        activeFolderId = 0;
      }
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyCatalog = false;
    }
  }

  async function loadStatus() {
    try {
      const payload = await request<{
        activeRun: Run | null;
        latestRun: Run | null;
        logs: RunLog[];
        chats: Chat[];
      }>("/api/sync/status");

      activeRun = payload.activeRun;
      latestRun = payload.latestRun;
      logs = payload.logs;
      chats = mergeStatusChats(payload.chats);
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    }
  }

  function ensurePolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    pollTimer = setInterval(() => {
      loadStatus().catch((error) => {
        uiError = error instanceof Error ? error.message : String(error);
      });
    }, 4000);
  }

  function toggleChat(peerId: string, checked: boolean) {
    const next = new Set(selectedPeerIds);
    if (checked) {
      next.add(peerId);
    } else {
      next.delete(peerId);
    }
    selectedPeerIds = next;
  }

  async function estimateSelected() {
    busyEstimate = true;
    uiError = "";

    try {
      const selected = Array.from(selectedPeerIds);
      if (selected.length === 0) {
        throw new Error("Select at least one chat before estimating");
      }

      await request<{
        estimates: Array<{
          peerId: string;
          estimatedMessages: number | null;
          estimatedEtaSeconds: number | null;
          estimateMode: "exact" | "lower_bound" | "unknown";
        }>;
      }>(
        "/api/sync/estimate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chatPeerIds: selected })
        }
      );

      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyEstimate = false;
    }
  }

  async function startSync() {
    busyStart = true;
    uiError = "";

    try {
      const selected = Array.from(selectedPeerIds);
      if (selected.length === 0) {
        throw new Error("Select at least one chat to start sync");
      }

      await request<{ run: Run }>("/api/sync/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatPeerIds: selected })
      });

      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyStart = false;
    }
  }

  async function clearSyncDataDebug() {
    if (!window.confirm("This will delete all synced messages and sync metadata. MTProto session data will be kept. Continue?")) {
      return;
    }

    busyDebugClear = true;
    uiError = "";

    try {
      await request<{ ok: true }>("/api/sync/debug/clear", {
        method: "POST"
      });

      activeRun = null;
      latestRun = null;
      logs = [];
      selectedPeerIds = new Set();
      await loadCatalog();
      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyDebugClear = false;
    }
  }

  function inActiveFolder(chat: Chat): boolean {
    return activeFolderId === 0 ? true : chat.folderIds.includes(activeFolderId);
  }

  function initialsForChat(chat: Chat): string {
    const parts = chat.title
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);

    if (parts.length === 0) {
      return "?";
    }

    return parts
      .map((part) => Array.from(part)[0] ?? "")
      .join("")
      .toUpperCase();
  }

  function hideAvatar(peerId: string) {
    const next = new Set(hiddenAvatarPeerIds);
    next.add(peerId);
    hiddenAvatarPeerIds = next;
  }

  function shouldShowAvatar(chat: Chat): boolean {
    return Boolean(chat.avatarUrl) && !hiddenAvatarPeerIds.has(chat.peerId);
  }

  function sortByTelegramOrder(a: Chat, b: Chat): number {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }

    const aDate = a.lastMessageDate ? new Date(a.lastMessageDate).getTime() : 0;
    const bDate = b.lastMessageDate ? new Date(b.lastMessageDate).getTime() : 0;
    if (aDate !== bDate) {
      return bDate - aDate;
    }

    const aMessageId = a.lastMessageId ?? 0;
    const bMessageId = b.lastMessageId ?? 0;
    if (aMessageId !== bMessageId) {
      return bMessageId - aMessageId;
    }

    return a.title.localeCompare(b.title);
  }

  $: visibleChats = chats.filter(inActiveFolder).sort(sortByTelegramOrder);
  $: progress =
    activeRun && activeRun.estimatedMessages > 0
      ? Math.min(100, Math.round((activeRun.processedMessages / activeRun.estimatedMessages) * 100))
      : 0;

  onMount(() => {
    Promise.all([loadCatalog(), loadStatus()]).catch((error) => {
      uiError = error instanceof Error ? error.message : String(error);
    });
    ensurePolling();
  });

  onDestroy(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
  });
</script>

<main class="shell">
  <section class="card">
    <header class="card-head">
      <div>
        <h1>Chat Sync</h1>
        <p>Select private chats to sync historical messages. Sync is resumable and safe to restart.</p>
      </div>
      <a class="setup-link" href="/setup">Back to setup</a>
    </header>

    {#if uiError}
      <p class="error">{uiError}</p>
    {/if}

    <section class="run-panel">
      <div class="run-head">
        <h2>Run status</h2>
        <button type="button" class="danger" on:click={clearSyncDataDebug} disabled={busyDebugClear}>
          {busyDebugClear ? "Clearing..." : "Debug: clear sync data"}
        </button>
      </div>
      {#if activeRun}
        <p>
          Active run <strong>#{activeRun.id}</strong> is <strong>{activeRun.status}</strong>.
          {#if activeRun.currentChatPeerId}
            Current chat: <code>{activeRun.currentChatPeerId}</code>
          {/if}
        </p>
        {#if activeRun.status === "queued"}
          <p class="hint">Run is queued. Start the worker with <code>bun run dev:userbot</code> to begin processing.</p>
        {/if}
        <div class="progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
          <div class="progress" style={`width: ${progress}%`}></div>
        </div>
        <p class="run-meta">
          {activeRun.processedMessages}/{activeRun.estimatedMessages || "?"} messages · {activeRun.completedChats}/{activeRun.totalChats} chats · ETA {formatSeconds(activeRun.etaSeconds)}
        </p>
      {:else if latestRun}
        <p>
          Latest run <strong>#{latestRun.id}</strong> ended with <strong>{latestRun.status}</strong>.
          {#if latestRun.lastError}
            Error: {compactText(latestRun.lastError, 320)}
          {/if}
        </p>
      {:else}
        <p>No sync runs yet.</p>
      {/if}

      {#if logs.length > 0}
        <div class="logs">
          {#each logs as log (log.id)}
            <p>
              <span class={`log-level ${log.level}`}>{log.level}</span>
              <span>{new Date(log.createdAt).toLocaleTimeString()} — {compactText(log.message)}</span>
            </p>
          {/each}
        </div>
      {/if}
    </section>

    <section class="chats">
      <div class="chats-head">
        <div class="chats-head-main">
          <h2>Private chats</h2>
        </div>
        <div class="actions">
          <button type="button" on:click={estimateSelected} disabled={busyEstimate || selectedPeerIds.size === 0}>Estimate selected</button>
          <button type="button" class="primary" on:click={startSync} disabled={busyStart || selectedPeerIds.size === 0}>Start synchronizing</button>
        </div>
      </div>

      <div class="folder-tabs" role="tablist" aria-label="Chat folders">
        {#if busyCatalog}
          <p>Loading folders…</p>
        {:else}
          {#each folders as folder}
            <button
              class:active={folder.id === activeFolderId}
              type="button"
              role="tab"
              aria-selected={folder.id === activeFolderId}
              on:click={() => {
                activeFolderId = folder.id;
              }}
            >
              {folder.title}
            </button>
          {/each}
        {/if}
      </div>

      {#if visibleChats.length === 0}
        <p>No private chats found in this folder.</p>
      {:else}
        <ul>
          {#each visibleChats as chat (chat.peerId)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={selectedPeerIds.has(chat.peerId)}
                  on:change={(event) => toggleChat(chat.peerId, (event.currentTarget as HTMLInputElement).checked)}
                />
                <span class="chat-main">
                  <span class="avatar">
                    {#if shouldShowAvatar(chat)}
                      <img src={chat.avatarUrl ?? undefined} alt={`Avatar for ${chat.title}`} on:error={() => hideAvatar(chat.peerId)} />
                    {:else}
                      <span>{initialsForChat(chat)}</span>
                    {/if}
                  </span>
                  <span>
                    <span class="chat-title">{chat.title} <span class="chat-id">({chat.peerId})</span></span>
                    {#if chat.username}
                      <span class="chat-username">@{chat.username}</span>
                    {/if}
                  </span>
                </span>
              </label>
                <div class="chat-meta">
                  {#if chat.isPinned}
                    <span class="pin" title="Pinned in Telegram">📌</span>
                  {/if}
                  <span class={`status ${chat.status}`}>{statusLabel[chat.status]}</span>
                  {#if formatChatEstimate(chat)}
                    <span>{formatChatEstimate(chat)}</span>
                  {/if}
                {#if shouldShowChatEta(chat)}
                  <span>ETA {formatSeconds(chat.estimatedEtaSeconds)}</span>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: ui-sans-serif, -apple-system, sans-serif;
    background: linear-gradient(180deg, #edf2fb, #f8faff);
    color: #17243f;
  }

  .shell {
    min-height: 100vh;
    padding: 20px;
  }

  .card {
    width: min(1120px, 100%);
    margin: 0 auto;
    border: 1px solid #d8e0f2;
    border-radius: 20px;
    background: #fff;
    padding: 22px;
    box-shadow: 0 12px 28px rgba(21, 40, 79, 0.08);
  }

  .card-head {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: flex-start;
    margin-bottom: 14px;
  }

  h1,
  h2 {
    margin: 0;
  }

  .card-head p {
    margin: 8px 0 0;
  }

  .setup-link {
    align-self: center;
    text-decoration: none;
    color: #225bc7;
    font-weight: 600;
  }

  .error {
    border: 1px solid #f1b5b5;
    border-radius: 12px;
    background: #fff4f4;
    color: #8b1d1d;
    padding: 10px 12px;
  }

  .run-panel {
    border: 1px solid #dae4f5;
    border-radius: 14px;
    padding: 14px;
    background: #f8fbff;
  }

  .run-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .danger {
    border: 1px solid #f0b5b5;
    border-radius: 10px;
    background: #fff4f4;
    color: #8b1d1d;
    padding: 8px 12px;
    cursor: pointer;
    font-weight: 600;
  }

  .progress-wrap {
    width: 100%;
    height: 12px;
    border-radius: 999px;
    background: #d8e2f6;
    overflow: hidden;
  }

  .progress {
    height: 100%;
    background: linear-gradient(90deg, #2f7fd9, #2ab39a);
  }

  .run-meta {
    margin: 8px 0 0;
    color: #2f466f;
  }

  .hint {
    margin: 8px 0;
    color: #385a8d;
    font-size: 0.92rem;
  }

  .logs {
    margin-top: 12px;
    max-height: 180px;
    overflow: auto;
    border: 1px solid #d8e0ef;
    border-radius: 10px;
    padding: 10px;
    background: #fff;
  }

  .logs p {
    margin: 0 0 8px;
    font-size: 0.9rem;
    display: flex;
    gap: 10px;
  }

  .logs p:last-child {
    margin-bottom: 0;
  }

  .logs p span:last-child {
    overflow-wrap: anywhere;
  }

  .log-level {
    text-transform: uppercase;
    font-size: 0.72rem;
    font-weight: 700;
    min-width: 52px;
  }

  .log-level.error {
    color: #a62d2d;
  }

  .log-level.warn {
    color: #9f6b1a;
  }

  .log-level.info {
    color: #2a4f96;
  }

  .chats {
    border: 1px solid #d8e0ef;
    border-radius: 14px;
    padding: 12px;
    margin-top: 16px;
  }

  .chats-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
  }

  .chats-head-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .folder-tabs {
    margin-top: 10px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: thin;
  }

  .folder-tabs button {
    border: 1px solid #d3dcf0;
    border-radius: 999px;
    background: #fff;
    padding: 7px 12px;
    cursor: pointer;
    color: inherit;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .folder-tabs button.active {
    border-color: #2d6fd0;
    background: #edf3ff;
    color: #1d4fa0;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .actions button {
    border: 1px solid #d0d8e8;
    border-radius: 10px;
    padding: 8px 12px;
    background: #fff;
    cursor: pointer;
  }

  .actions button.primary {
    background: #1b67d4;
    color: #fff;
    border-color: #1b67d4;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  ul {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
  }

  li {
    border-top: 1px solid #ebeff8;
    padding: 10px 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }

  li:first-child {
    border-top: 0;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .chat-main {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 999px;
    overflow: hidden;
    border: 1px solid #d0d9eb;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(180deg, #f2f6ff, #e8eefc);
    color: #2a4b82;
    font-size: 0.76rem;
    font-weight: 700;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .chat-title {
    font-weight: 600;
    display: block;
  }

  .chat-id {
    color: #8393b2;
    font-weight: 500;
    font-size: 0.85rem;
  }

  .chat-username {
    display: block;
    color: #58709a;
    font-size: 0.82rem;
  }

  .chat-meta {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
    font-size: 0.85rem;
  }

  .status {
    border-radius: 999px;
    padding: 3px 8px;
    border: 1px solid transparent;
  }

  .status.pending {
    background: #f1f4fb;
    border-color: #d6deef;
    color: #394f75;
  }

  .status.syncing {
    background: #edf6ff;
    border-color: #cfe2ff;
    color: #1d61bc;
  }

  .status.synced {
    background: #ebfaef;
    border-color: #c6efce;
    color: #2a7c3f;
  }

  .status.error {
    background: #fff1f1;
    border-color: #f2c4c4;
    color: #9d2626;
  }

  .pin {
    font-size: 0.9rem;
    line-height: 1;
  }

  @media (max-width: 900px) {
    .card-head,
    .chats-head {
      flex-direction: column;
      align-items: flex-start;
    }

    .run-head {
      flex-direction: column;
      align-items: flex-start;
    }

    .chat-meta {
      justify-content: flex-start;
    }

    .chats-head-main {
      width: 100%;
    }
  }
</style>
