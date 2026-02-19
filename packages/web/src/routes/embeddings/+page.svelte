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
    isPinned: boolean;
    avatarUrl: string | null;
    folderIds: number[];
    lastMessageId: number | null;
    lastMessageDate: string | null;
    selected: boolean;
    status: "pending" | "embedding" | "embedded" | "error";
    isEmbedded: boolean;
    estimatedMode: "exact" | "unknown";
    estimatedMessages: number | null;
    estimatedEtaSeconds: number | null;
    lastEmbeddedAt: string | null;
    lastError: string | null;
  };

  type Run = {
    id: number;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    model: string;
    totalChats: number;
    completedChats: number;
    estimatedMessages: number;
    processedMessages: number;
    etaSeconds: number | null;
    currentChatPeerId: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
    updatedAt?: string;
  };

  type RunLog = {
    id: number;
    level: string;
    message: string;
    meta: Record<string, unknown> | null;
    createdAt: string;
  };

  let model = "";
  let folders: Folder[] = [];
  let chats: Chat[] = [];
  let activeFolderId = 0;
  let selectedPeerIds = new Set<string>();
  let activeRun: Run | null = null;
  let latestRun: Run | null = null;
  let logs: RunLog[] = [];
  let progressByPeerId = new Map<string, { processed: number; total: number | null }>();
  let hiddenAvatarPeerIds = new Set<string>();
  let busyCatalog = false;
  let busyEstimate = false;
  let busyStart = false;
  let busyStop = false;
  let busyReset = false;
  let busyDebugClear = false;
  let uiError = "";
  let uiNotice = "";
  let busyStatus = false;
  let lastStatusAt: Date | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const statusLabel: Record<Chat["status"], string> = {
    pending: "Pending",
    embedding: "Embedding",
    embedded: "✓ Embedded",
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

  function formatThroughput(run: Run): string {
    if (!run.startedAt || run.processedMessages <= 0) {
      return "Throughput -";
    }

    const startedAtMs = new Date(run.startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) {
      return "Throughput -";
    }

    const elapsedMinutes = (Date.now() - startedAtMs) / 60000;
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) {
      return "Throughput -";
    }

    const perMinute = run.processedMessages / elapsedMinutes;
    if (!Number.isFinite(perMinute) || perMinute <= 0) {
      return "Throughput -";
    }

    return `Throughput ${perMinute.toFixed(perMinute >= 100 ? 0 : 1)} msgs/min`;
  }

  function compactText(value: string, max = 260): string {
    if (value.length <= max) {
      return value;
    }

    return `${value.slice(0, max - 3)}...`;
  }

  function formatStatusTime(value: Date | null): string {
    if (!value) {
      return "never";
    }

    return value.toLocaleTimeString();
  }

  function formatRunActivity(run: Run): string {
    if (!run.updatedAt) {
      return "Activity unknown";
    }

    const updatedMs = new Date(run.updatedAt).getTime();
    if (!Number.isFinite(updatedMs)) {
      return "Activity unknown";
    }

    const secondsAgo = Math.max(0, Math.floor((Date.now() - updatedMs) / 1000));
    if (secondsAgo < 5) {
      return "Activity just now";
    }

    if (secondsAgo < 60) {
      return `Activity ${secondsAgo}s ago`;
    }

    const minutesAgo = Math.floor(secondsAgo / 60);
    return `Activity ${minutesAgo}m ago`;
  }

  function formatChatEstimate(chat: Chat): string | null {
    if (chat.estimatedMessages === null) {
      return null;
    }

    return `${chat.estimatedMessages} msgs`;
  }

  function toFiniteNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    return value;
  }

  function formatCurrentChatProgress(chat: Chat): string | null {
    const progress = progressByPeerId.get(chat.peerId);
    if (!progress) {
      return null;
    }

    const processed = Math.max(0, Math.floor(progress.processed));
    const fallbackTotal =
      typeof chat.estimatedMessages === "number" && Number.isFinite(chat.estimatedMessages)
        ? Math.max(0, Math.floor(chat.estimatedMessages))
        : null;
    const total =
      progress.total !== null
        ? Math.max(0, Math.floor(progress.total))
        : fallbackTotal;

    if (total !== null && total > 0) {
      return `${Math.min(processed, total)}/${total}`;
    }

    return `${processed}/?`;
  }

  function applySelectionFromChats(items: Chat[]) {
    selectedPeerIds = new Set(items.filter((chat) => chat.selected).map((chat) => chat.peerId));
  }

  function mergeStatusChats(nextChats: Chat[]): Chat[] {
    const nextByPeerId = new Map(nextChats.map((chat) => [chat.peerId, chat]));

    return chats.map((existing) => {
      const next = nextByPeerId.get(existing.peerId);
      if (!next) {
        return existing;
      }

      return {
        ...existing,
        ...next,
        isPinned: existing.isPinned,
        avatarUrl: existing.avatarUrl
      };
    });
  }

  async function loadCatalog() {
    busyCatalog = true;
    uiError = "";

    try {
      const payload = await request<{ model: string; folders: Folder[]; chats: Chat[] }>("/api/embeddings/catalog");
      model = payload.model;
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
    busyStatus = true;
    try {
      const payload = await request<{
        model: string;
        activeRun: Run | null;
        latestRun: Run | null;
        logs: RunLog[];
        chats: Chat[];
      }>("/api/embeddings/status");

      model = payload.model;
      activeRun = payload.activeRun;
      latestRun = payload.latestRun;
      logs = payload.logs;
      chats = mergeStatusChats(payload.chats);
      lastStatusAt = new Date();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyStatus = false;
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

  function setVisibleChatsSelection(checked: boolean) {
    const next = new Set(selectedPeerIds);

    for (const chat of visibleChats) {
      if (checked) {
        next.add(chat.peerId);
      } else {
        next.delete(chat.peerId);
      }
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

      await request<{ estimates: Array<{ peerId: string }> }>("/api/embeddings/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatPeerIds: selected })
      });

      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyEstimate = false;
    }
  }

  async function startEmbeddings() {
    busyStart = true;
    uiError = "";
    uiNotice = "";

    try {
      const selected = Array.from(selectedPeerIds);
      if (selected.length === 0) {
        throw new Error("Select at least one chat to start embeddings");
      }

      const payload = await request<{ run: Run; reusedExistingRun?: boolean }>("/api/embeddings/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatPeerIds: selected })
      });

      activeRun = payload.run;
      latestRun = payload.run;
      uiNotice = payload.reusedExistingRun
        ? `Run #${payload.run.id} is already active, resuming from current progress.`
        : payload.run.status === "queued"
          ? `Run #${payload.run.id} queued. Worker will pick it up shortly.`
          : `Run #${payload.run.id} started.`;

      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyStart = false;
    }
  }

  async function stopEmbeddings() {
    if (!activeRun || (activeRun.status !== "queued" && activeRun.status !== "running")) {
      return;
    }

    busyStop = true;
    uiError = "";
    uiNotice = "";

    try {
      const payload = await request<{ stopped: boolean; run: Run | null }>("/api/embeddings/stop", {
        method: "POST"
      });

      if (payload.stopped && payload.run) {
        uiNotice = `Run #${payload.run.id} stopped.`;
      } else {
        uiNotice = "No active embedding run to stop.";
      }

      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyStop = false;
    }
  }

  async function resetSelected() {
    const selected = Array.from(selectedPeerIds);
    if (selected.length === 0) {
      uiError = "Select at least one chat to reset embeddings";
      return;
    }

    if (!window.confirm(`Reset embeddings for ${selected.length} selected chat(s)?`)) {
      return;
    }

    busyReset = true;
    uiError = "";

    try {
      await request<{ ok: true }>("/api/embeddings/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatPeerIds: selected })
      });

      await loadStatus();
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busyReset = false;
    }
  }

  async function clearEmbeddingsDataDebug() {
    if (!window.confirm("This will delete all embeddings data (vectors, runs, logs, checkpoints). Continue?")) {
      return;
    }

    busyDebugClear = true;
    uiError = "";

    try {
      await request<{ ok: true }>("/api/embeddings/debug/clear", {
        method: "POST"
      });

      activeRun = null;
      latestRun = null;
      logs = [];
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
  $: selectedVisibleCount = visibleChats.filter((chat) => selectedPeerIds.has(chat.peerId)).length;
  $: allVisibleSelected = visibleChats.length > 0 && selectedVisibleCount === visibleChats.length;
  $: progress =
    activeRun && activeRun.estimatedMessages > 0
      ? Math.min(100, Math.round((activeRun.processedMessages / activeRun.estimatedMessages) * 100))
      : 0;
  $: progressByPeerId = (() => {
    const next = new Map<string, { processed: number; total: number | null }>();

    for (const log of logs) {
      if (log.message !== "Embedded message batch" || !log.meta) {
        continue;
      }

      const peerId = typeof log.meta.chatPeerId === "string" ? log.meta.chatPeerId : null;
      const processed = toFiniteNumber(log.meta.processedInChat);
      if (!peerId || processed === null) {
        continue;
      }

      const total = toFiniteNumber(log.meta.targetMessages);
      next.set(peerId, { processed, total });
    }

    return next;
  })();

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
        <h1>Embeddings</h1>
        <p>Generate per-message vectors for synced chats. This powers better retrieval quality for answers.</p>
      </div>
      <div class="head-links">
        <a class="setup-link" href="/sync">Open sync</a>
        <a class="setup-link" href="/setup">Back to setup</a>
      </div>
    </header>

    <p class="model-line">Model: <code>{model || "(loading...)"}</code></p>

    {#if uiError}
      <p class="error">{uiError}</p>
    {/if}

    {#if uiNotice}
      <p class="notice">{uiNotice}</p>
    {/if}

    <section class="run-panel">
      <div class="run-head">
        <h2>Run status</h2>
        <div class="run-head-right">
          <span class="poll-meta" aria-live="polite">
            {busyStatus ? "Refreshing..." : `Updated ${formatStatusTime(lastStatusAt)}`}
          </span>
          {#if activeRun && (activeRun.status === "queued" || activeRun.status === "running")}
            <button type="button" class="warning" on:click={stopEmbeddings} disabled={busyStop}>
              {busyStop ? "Stopping..." : "Stop run"}
            </button>
          {/if}
          <button type="button" class="danger" on:click={clearEmbeddingsDataDebug} disabled={busyDebugClear}>
            {busyDebugClear ? "Clearing..." : "Debug: clear embeddings"}
          </button>
        </div>
      </div>
      {#if activeRun}
        <p>
          Active run <strong>#{activeRun.id}</strong> is <strong>{activeRun.status}</strong>.
          {#if activeRun.currentChatPeerId}
            Current chat: <code>{activeRun.currentChatPeerId}</code>
          {/if}
        </p>
        {#if activeRun.status === "queued"}
          <p class="hint">Run is queued. Start the worker with <code>bun run dev:userbot</code>.</p>
        {/if}
        <div class="progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
          <div class="progress" style={`width: ${progress}%`}></div>
        </div>
        <p class="run-meta">
          {activeRun.processedMessages} messages processed · {activeRun.completedChats}/{activeRun.totalChats} chats · {formatThroughput(activeRun)} · {formatRunActivity(activeRun)}
        </p>
      {:else if latestRun}
        <p>
          Latest run <strong>#{latestRun.id}</strong> ended with <strong>{latestRun.status}</strong>.
          {#if latestRun.lastError}
            Error: {compactText(latestRun.lastError, 320)}
          {/if}
        </p>
      {:else}
        <p>No embedding runs yet.</p>
      {/if}

      {#if logs.length > 0}
        <div class="logs">
          {#each logs as log (log.id)}
            <p>
              <span class={`log-level ${log.level}`}>{log.level}</span>
              <span>{new Date(log.createdAt).toLocaleTimeString()} - {compactText(log.message)}</span>
            </p>
          {/each}
        </div>
      {:else if activeRun}
        <p class="hint">No worker logs yet for this run. If it stays empty, ensure <code>bun run dev:userbot</code> is running.</p>
      {/if}
    </section>

    <section class="chats">
      <div class="chats-head">
        <div class="chats-head-main">
          <h2>Synced chats</h2>
          <p class="selection-meta">Selected {selectedVisibleCount}/{visibleChats.length} shown</p>
        </div>
        <div class="actions">
          <button
            type="button"
            on:click={() => setVisibleChatsSelection(!allVisibleSelected)}
            disabled={visibleChats.length === 0}
          >
            {allVisibleSelected ? "Deselect all shown" : "Select all shown"}
          </button>
          <button type="button" on:click={estimateSelected} disabled={busyEstimate || selectedPeerIds.size === 0}>Estimate selected</button>
          <button type="button" on:click={resetSelected} disabled={busyReset || selectedPeerIds.size === 0}>
            {busyReset ? "Resetting..." : "Reset selected"}
          </button>
          <button
            type="button"
            class="primary"
            on:click={startEmbeddings}
            disabled={busyStart || selectedPeerIds.size === 0 || activeRun?.status === "queued" || activeRun?.status === "running"}
          >
            {busyStart ? "Starting..." : activeRun?.status === "queued" || activeRun?.status === "running" ? "Run in progress" : "Start embeddings"}
          </button>
        </div>
      </div>

      <div class="folder-tabs" role="tablist" aria-label="Chat folders">
        {#if busyCatalog}
          <p>Loading folders...</p>
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
        <p>No synced chats found in this folder. Sync chats first on <a href="/sync">/sync</a>.</p>
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
                {#if chat.status === "embedding" && formatCurrentChatProgress(chat)}
                  <span class="chat-progress">{formatCurrentChatProgress(chat)}</span>
                {/if}
                {#if formatChatEstimate(chat)}
                  <span>{formatChatEstimate(chat)}</span>
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
    background: linear-gradient(180deg, #f4f8f0, #f9fcf6);
    color: #152a1d;
  }

  .shell {
    min-height: 100vh;
    padding: 20px;
  }

  .card {
    width: min(1120px, 100%);
    margin: 0 auto;
    border: 1px solid #d8e7d4;
    border-radius: 20px;
    background: #fff;
    padding: 22px;
    box-shadow: 0 12px 28px rgba(22, 57, 29, 0.08);
  }

  .card-head {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: flex-start;
    margin-bottom: 8px;
  }

  h1,
  h2 {
    margin: 0;
  }

  .card-head p {
    margin: 8px 0 0;
  }

  .head-links {
    display: flex;
    gap: 8px;
  }

  .setup-link {
    align-self: center;
    text-decoration: none;
    color: #237646;
    font-weight: 600;
  }

  .model-line {
    margin: 0 0 14px;
    color: #335244;
    font-size: 0.95rem;
  }

  .error {
    border: 1px solid #f1b5b5;
    border-radius: 12px;
    background: #fff4f4;
    color: #8b1d1d;
    padding: 10px 12px;
  }

  .notice {
    border: 1px solid #b9dfc4;
    border-radius: 12px;
    background: #eef9f1;
    color: #235f36;
    padding: 10px 12px;
  }

  .run-panel {
    border: 1px solid #d9e9d8;
    border-radius: 14px;
    padding: 14px;
    background: #f8fcf7;
  }

  .run-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .run-head-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .poll-meta {
    font-size: 0.82rem;
    color: #5c7a66;
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

  .warning {
    border: 1px solid #e9c98b;
    border-radius: 10px;
    background: #fff8e8;
    color: #8a5b17;
    padding: 8px 12px;
    cursor: pointer;
    font-weight: 600;
  }

  .progress-wrap {
    width: 100%;
    height: 12px;
    border-radius: 999px;
    background: #d8ead9;
    overflow: hidden;
  }

  .progress {
    height: 100%;
    background: linear-gradient(90deg, #36965b, #6aa51d);
  }

  .run-meta {
    margin: 8px 0 0;
    color: #325c41;
  }

  .hint {
    margin: 8px 0;
    color: #2f6243;
    font-size: 0.92rem;
  }

  .logs {
    margin-top: 12px;
    max-height: 180px;
    overflow: auto;
    border: 1px solid #d9e6d7;
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
    color: #2d7d49;
  }

  .chats {
    border: 1px solid #d8e6d6;
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

  .selection-meta {
    margin: 4px 0 0;
    font-size: 0.82rem;
    color: #517562;
  }

  .folder-tabs button {
    border: 1px solid #cfdecb;
    border-radius: 999px;
    background: #fff;
    padding: 7px 12px;
    cursor: pointer;
    color: inherit;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .folder-tabs button.active {
    border-color: #3d8f4f;
    background: #eef9ed;
    color: #2e6f3c;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .actions button {
    border: 1px solid #cbdcc8;
    border-radius: 10px;
    padding: 8px 12px;
    background: #fff;
    cursor: pointer;
  }

  .actions button.primary {
    background: #2b8a46;
    color: #fff;
    border-color: #2b8a46;
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
    border-top: 1px solid #ebf3e8;
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
    border: 1px solid #c9dcc4;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(180deg, #f2fbef, #e8f4e4);
    color: #2f6f3c;
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
    color: #7e9a85;
    font-weight: 500;
    font-size: 0.85rem;
  }

  .chat-username {
    display: block;
    color: #5a7f67;
    font-size: 0.82rem;
  }

  .chat-meta {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
    font-size: 0.85rem;
  }

  .chat-progress {
    border-radius: 999px;
    border: 1px solid #bfd9c5;
    background: #f2fbf3;
    color: #2f6d3e;
    padding: 3px 8px;
    font-variant-numeric: tabular-nums;
  }

  .status {
    border-radius: 999px;
    padding: 3px 8px;
    border: 1px solid transparent;
  }

  .status.pending {
    background: #f2f7f2;
    border-color: #d7e5d6;
    color: #3c5c42;
  }

  .status.embedding {
    background: #edf9ef;
    border-color: #cae7cf;
    color: #2f7e44;
  }

  .status.embedded {
    background: #e8f7eb;
    border-color: #b8e0c1;
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
