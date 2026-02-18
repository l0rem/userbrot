<script lang="ts">
  import { onMount } from "svelte";
  import type { PageData } from "./$types";

  export let data: PageData;

  type SetupState = {
    status: "not_configured" | "awaiting_code" | "awaiting_password" | "configured";
    requiresPassword: boolean;
    codeType?: string;
  };

  let phone = data.defaultPhone ?? "";
  let code = "";
  let password = "";
  let busy = false;
  let uiError = "";
  let state: SetupState = data.initialSetup;

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? `Request failed with ${response.status}`);
    }

    return payload;
  }

  async function refreshStatus() {
    uiError = "";
    state = await request<SetupState>("/api/setup/status");
  }

  async function startSetup() {
    busy = true;
    uiError = "";
    try {
      state = await request<SetupState>("/api/setup/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone })
      });
      code = "";
      password = "";
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function submitCode() {
    busy = true;
    uiError = "";
    try {
      state = await request<SetupState>("/api/setup/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code || undefined
        })
      });
      if (state.status !== "awaiting_code") {
        code = "";
      }
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function submitPassword() {
    busy = true;
    uiError = "";
    try {
      state = await request<SetupState>("/api/setup/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password: password || undefined
        })
      });

      if (state.status === "configured") {
        password = "";
      }
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function resetSetup() {
    busy = true;
    uiError = "";
    try {
      state = await request<SetupState>("/api/setup/reset", { method: "POST" });
      code = "";
      password = "";
    } catch (error) {
      uiError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    refreshStatus().catch((error) => {
      uiError = error instanceof Error ? error.message : String(error);
    });
  });
</script>

<main class="shell">
  <section class="card">
    <h1>Setup Wizard</h1>
    <p>Complete login in three steps. Fields appear only when needed.</p>

    {#if uiError}
      <p class="error">{uiError}</p>
    {/if}

    {#if state.status === "not_configured"}
      <label for="phone">Phone number</label>
      <input id="phone" type="tel" bind:value={phone} placeholder="+1234567890" autocomplete="tel" />
      <button on:click={startSetup} disabled={busy || phone.trim().length < 7}>Send code</button>
    {/if}

    {#if state.status === "awaiting_code"}
      <label for="code">SMS/App code</label>
      <input id="code" bind:value={code} placeholder="12345" inputmode="numeric" autocomplete="one-time-code" />
      <button on:click={submitCode} disabled={busy || code.trim().length < 4}>Verify code</button>
    {/if}

    {#if state.status === "awaiting_password"}
      <label for="password">2FA password</label>
      <input
        id="password"
        type="password"
        bind:value={password}
        placeholder="Enter your Telegram 2FA password"
        autocomplete="current-password"
      />
      <button on:click={submitPassword} disabled={busy || password.trim().length < 1}>Verify password</button>
    {/if}

    {#if state.status === "configured"}
      <p class="success">Setup completed. Session is stored and ready for userbot reuse.</p>
      <p class="next-step"><a href="/sync">Continue to chat sync</a></p>
    {/if}

    <button class="danger" on:click={resetSetup} disabled={busy}>Reset setup</button>

    <p class="hint">Current status: <strong>{state.status}</strong></p>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: ui-sans-serif, -apple-system, sans-serif;
    background: #f4f6fb;
    color: #12203a;
  }

  .shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .card {
    width: min(760px, 100%);
    border: 1px solid #d8dfef;
    border-radius: 18px;
    padding: 28px;
    background: #ffffff;
    box-shadow: 0 12px 30px rgba(18, 32, 58, 0.08);
  }

  h1 {
    margin: 0 0 10px;
    font-size: clamp(2rem, 3vw, 3rem);
  }

  p {
    margin: 0 0 18px;
    font-size: 1.15rem;
  }

  .error {
    margin-bottom: 16px;
    border: 1px solid #f0b5b5;
    border-radius: 12px;
    background: #fff4f4;
    color: #8d1f1f;
    padding: 10px 12px;
    font-size: 0.95rem;
  }

  .success {
    margin: 8px 0 0;
    border: 1px solid #b7dfc7;
    border-radius: 12px;
    background: #f3fff7;
    color: #1f6235;
    padding: 10px 12px;
    font-size: 0.95rem;
  }

  .next-step {
    margin: 10px 0 0;
    font-size: 0.95rem;
  }

  .next-step a {
    color: #1457cf;
    font-weight: 700;
    text-decoration: none;
  }

  .next-step a:hover {
    text-decoration: underline;
  }

  label {
    display: block;
    margin: 18px 0 8px;
    font-size: 1.2rem;
    font-weight: 700;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    border: 2px solid #c9d5f4;
    border-radius: 16px;
    padding: 14px 18px;
    font-size: 1.05rem;
    color: inherit;
    background: #fff;
  }

  input:focus {
    outline: none;
    border-color: #4c7fe8;
  }

  button {
    margin-top: 14px;
    margin-right: 10px;
    border: 0;
    border-radius: 14px;
    padding: 12px 24px;
    font-size: 1rem;
    font-weight: 600;
    color: #fff;
    background: #1457cf;
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .danger {
    background: #9a2f2f;
  }

  .hint {
    margin-top: 18px;
    font-size: 0.9rem;
    color: #2c3f69;
  }

  @media (max-width: 860px) {
    .card {
      padding: 22px;
    }

    label {
      font-size: 1.05rem;
    }

    p,
    input,
    button,
    .hint,
    .error,
    .success {
      font-size: 0.95rem;
    }
  }
</style>
