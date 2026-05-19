// Settings window — talks to the main process via window.electronAPI.

const hotkeyInput = document.getElementById('hotkey');
const hotkeyRecord = document.getElementById('hotkey-record');
const hotkeyDisable = document.getElementById('hotkey-disable');
const hotkeyError = document.getElementById('hotkey-error');
const hotkeyStatus = document.getElementById('hotkey-status');
const closeToTray = document.getElementById('close-to-tray');
const resetBtn = document.getElementById('reset');
const closeBtn = document.getElementById('close');

let recording = false;

function showError(msg) {
  if (!msg) {
    hotkeyError.style.display = 'none';
    hotkeyError.textContent = '';
    return;
  }
  hotkeyError.style.display = '';
  hotkeyError.textContent = msg;
}

function setStatus(msg) {
  hotkeyStatus.textContent = msg ?? '';
}

function eventToAccelerator(e) {
  // Map a DOM keydown to an Electron accelerator string.
  // Modifiers: CommandOrControl (cross-platform), Alt, Shift.
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  let key = e.key;
  if (!key) return null;
  // Ignore bare modifier press
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null;
  // Normalise letter keys to upper-case
  if (/^[a-z]$/.test(key)) key = key.toUpperCase();
  // Map common keys to Electron names
  const map = {
    ' ': 'Space',
    Escape: 'Esc',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  if (map[key]) key = map[key];
  return mods.length > 0 ? `${mods.join('+')}+${key}` : key;
}

async function applyAndShow(accel) {
  showError(null);
  try {
    const ok = await window.electronAPI.setHotkey(accel);
    hotkeyInput.value = accel || '';
    if (!accel) {
      setStatus('Hotkey disabled.');
    } else if (!ok) {
      showError(
        'Could not register this shortcut — it may be in use by another application. Try a different combination.',
      );
      setStatus('');
    } else {
      setStatus(`Active: ${accel}`);
    }
  } catch (err) {
    showError((err && err.message) || 'Failed to update hotkey');
  }
}

function startRecording() {
  if (recording) return;
  recording = true;
  hotkeyRecord.textContent = 'Press a key…';
  hotkeyRecord.disabled = true;
  showError(null);

  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const accel = eventToAccelerator(e);
    if (!accel) return; // bare modifier — keep listening
    window.removeEventListener('keydown', onKey, true);
    recording = false;
    hotkeyRecord.textContent = 'Record';
    hotkeyRecord.disabled = false;
    await applyAndShow(accel);
  };
  window.addEventListener('keydown', onKey, true);
}

async function init() {
  try {
    const current = await window.electronAPI.getHotkey();
    hotkeyInput.value = current || '';
    setStatus(current ? `Active: ${current}` : 'Hotkey disabled.');
  } catch (_) {
    /* ignore */
  }
  try {
    const ctt = await window.electronAPI.getCloseToTray();
    closeToTray.checked = Boolean(ctt);
  } catch (_) {
    closeToTray.checked = true;
  }
}

hotkeyRecord.addEventListener('click', startRecording);
hotkeyDisable.addEventListener('click', () => applyAndShow(''));
closeToTray.addEventListener('change', () => {
  void window.electronAPI.setCloseToTray(closeToTray.checked);
});
resetBtn.addEventListener('click', () => {
  void window.electronAPI.deleteServerUrl();
});
closeBtn.addEventListener('click', () => window.close());

init();
