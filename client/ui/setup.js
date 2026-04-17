const STORE_FILE = "config.json";
const STORE_KEY = "serverUrl";

async function loadStore() {
  const { load } = window.__TAURI__.store;
  return load(STORE_FILE, { autoSave: false });
}

async function init() {
  try {
    const store = await loadStore();
    const savedUrl = await store.get(STORE_KEY);

    if (savedUrl) {
      window.location.href = savedUrl;
      return;
    }
  } catch (_) {
    // No saved URL or store not available — show setup form
  }

  document.getElementById("loading").style.display = "none";
  document.getElementById("setup").style.display = "block";
}

document.getElementById("setup").addEventListener("submit", async (e) => {
  e.preventDefault();

  const urlInput = document.getElementById("server-url");
  const url = urlInput.value.trim().replace(/\/+$/, "");
  if (!url) return;

  const errorEl = document.getElementById("error");
  const errorText = errorEl.querySelector(".error-text");

  try {
    const resp = await fetch(url + "/api/auth/me", {
      method: "GET",
      mode: "no-cors",
      signal: AbortSignal.timeout(5000),
    });

    // no-cors gives opaque response (status 0) which is fine — it means the server is reachable
    if (resp.type !== "opaque" && !resp.ok && resp.status !== 401) {
      throw new Error(`Server returned ${resp.status}`);
    }
  } catch (err) {
    errorText.textContent = `Could not reach server: ${err.message}`;
    errorEl.style.display = "block";
    return;
  }

  errorEl.style.display = "none";

  const store = await loadStore();
  await store.set(STORE_KEY, url);
  await store.save();

  window.location.href = url;
});

init();
