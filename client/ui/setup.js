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

async function probe(url) {
  let target;
  try {
    target = new URL("/api/auth/me", url).href;
  } catch (_) {
    throw new Error("Saved address is not a valid URL");
  }

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
    window.location.href = url;
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

  const store = await loadStore();
  await store.set(STORE_KEY, url);
  await store.save();

  window.location.href = url;
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
