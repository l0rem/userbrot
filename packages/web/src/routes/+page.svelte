<main class="shell">
  <section class="card">
    <h1>userbrot web backend is running</h1>
    <p>Open the setup flow to authorize your Telegram user account.</p>
    <a href="/setup">Open setup wizard</a>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: ui-sans-serif, -apple-system, sans-serif;
    background: linear-gradient(180deg, #e9eef9, #f4f6fb);
    color: #12203a;
  }

  .shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .card {
    width: min(540px, 100%);
    border: 1px solid #d8dfef;
    border-radius: 14px;
    padding: 24px;
    background: #ffffff;
    box-shadow: 0 10px 28px rgba(18, 32, 58, 0.08);
  }

  h1 {
    margin: 0 0 8px;
  }

  p {
    margin: 0 0 12px;
  }

  a {
    color: #0f5ad7;
    text-decoration: none;
    font-weight: 600;
  }

  a:hover {
    text-decoration: underline;
  }
</style>
