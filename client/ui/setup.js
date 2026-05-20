const STORE_FILE = "config.json";
const STORE_KEY = "serverUrl";

let probeInFlight = false;

async function loadStore() {
  const { load } = window.__TAURI__.store;
  return load(STORE_FILE, { autoSave: false });
}

function showView(name) {
  for (const id of ["loading", "setup", "error-screen"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.display = id === name ? "" : "none";
  }
}

function safeHttpUrl(raw) {
  // Only allow http(s) URLs. Blocks `javascript:` / `data:` and other
  // protocols that would turn `window.location.href = url` into an XSS sink.
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

async function probe(url) {
  const base = safeHttpUrl(url);
  if (!base) throw new Error("Saved address is not a valid http(s) URL");
  const target = new URL("/api/auth/me", base).href;

  let resp;
  try {
    resp = await fetch(target, {
      method: "GET",
      mode: "no-cors",
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    if (err && err.name === "TimeoutError") {
      throw new Error("Connection timed out after 5s");
    }
    if (err && err.name === "AbortError") {
      throw new Error("Request aborted");
    }
    throw new Error((err && err.message) || "Network error");
  }

  if (resp.type === "opaque") return;
  if (resp.ok || resp.status === 401) return;
  throw new Error(`Server returned ${resp.status}`);
}

function showErrorScreen(url, reason) {
  document.getElementById("error-screen-url").textContent = url;
  document.getElementById("error-screen-detail").textContent = reason;
  showView("error-screen");
}

async function attemptNavigate(url) {
  if (probeInFlight) return;
  probeInFlight = true;
  const retryBtn = document.getElementById("error-retry");
  if (retryBtn) retryBtn.disabled = true;
  showView("loading");
  try {
    await probe(url);
    const safe = safeHttpUrl(url);
    if (!safe) throw new Error("Saved address is not a valid http(s) URL");
    window.location.href = safe;
  } catch (err) {
    probeInFlight = false;
    if (retryBtn) retryBtn.disabled = false;
    showErrorScreen(url, err.message);
  }
}

async function clearSavedUrlAndShowSetup(prefillUrl) {
  try {
    const store = await loadStore();
    await store.delete(STORE_KEY);
    await store.save();
  } catch (_) {
    // Best-effort. If the store can't be touched, fall through to the form anyway.
  }
  const input = document.getElementById("server-url");
  if (prefillUrl) input.value = prefillUrl;
  showView("setup");
  input.focus();
}

async function init() {
  let savedUrl = null;
  try {
    const store = await loadStore();
    savedUrl = await store.get(STORE_KEY);
  } catch (_) {
    // Store unavailable — fall through to setup form.
  }

  if (typeof savedUrl === "string" && savedUrl) {
    await attemptNavigate(savedUrl);
    return;
  }
  showView("setup");
}

document.getElementById("setup").addEventListener("submit", async (e) => {
  e.preventDefault();

  const urlInput = document.getElementById("server-url");
  const url = urlInput.value.trim().replace(/\/+$/, "");
  if (!url) return;

  const errorEl = document.getElementById("error");
  const errorText = errorEl.querySelector(".error-text");
  errorEl.style.display = "none";

  try {
    await probe(url);
  } catch (err) {
    errorText.textContent = `Could not reach server: ${err.message}`;
    errorEl.style.display = "block";
    return;
  }

  const safe = safeHttpUrl(url);
  if (!safe) {
    errorText.textContent = "Address must start with http:// or https://";
    errorEl.style.display = "block";
    return;
  }

  const store = await loadStore();
  await store.set(STORE_KEY, safe);
  await store.save();

  window.location.href = safe;
});

document.getElementById("error-retry").addEventListener("click", () => {
  const url = document.getElementById("error-screen-url").textContent;
  if (url) attemptNavigate(url);
});

document.getElementById("error-change").addEventListener("click", () => {
  const url = document.getElementById("error-screen-url").textContent;
  clearSavedUrlAndShowSetup(url);
});

init();
