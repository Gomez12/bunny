'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  Tray,
  globalShortcut,
  nativeImage,
  shell,
  session,
  ipcMain,
} = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// ---------------------------------------------------------------------------
// Config storage

const CONFIG_FILE = join(app.getPath('userData'), 'config.json');
const DEFAULT_HOTKEY = 'CommandOrControl+B';

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(data) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function patchConfig(patch) {
  const next = { ...readConfig(), ...patch };
  writeConfig(next);
  return next;
}

// ---------------------------------------------------------------------------
// Chromium secure-context switch
//
// getUserMedia() requires a "secure context" (HTTPS or localhost). Chromium
// checks this before consulting the permission handler, so
// setPermissionRequestHandler alone is not enough for HTTP server URLs.
// app.commandLine.appendSwitch must be called BEFORE app.whenReady() —
// switches are frozen when the browser process initialises.

const savedUrl = readConfig().serverUrl ?? null;
if (savedUrl) {
  try {
    app.commandLine.appendSwitch(
      'unsafely-treat-insecure-origin-as-secure',
      new URL(savedUrl).origin
    );
  } catch {
    // Malformed saved URL — ignore; setup form will prompt again.
  }
}

// ---------------------------------------------------------------------------
// Module-scoped window references

let mainWindow = null;
let miniWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Helpers

function isInternal(url, serverUrl) {
  try {
    const t = new URL(url);
    if (['file:', 'about:', 'blob:', 'data:'].includes(t.protocol)) return true;
    if (serverUrl && t.origin === new URL(serverUrl).origin) return true;
    return false;
  } catch {
    return true; // Malformed URL — don't try to open externally.
  }
}

/**
 * Apply the navigation guards required for both the main and mini-windows.
 * Off-origin links open in the system browser; window.open() and
 * <a target="_blank"> never spawn a second BrowserWindow.
 */
function attachNavigationGuards(win, serverUrl) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url, serverUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url, serverUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// IPC

ipcMain.handle('store:get', () => readConfig().serverUrl ?? null);

ipcMain.handle('store:set', (_event, url) => {
  writeConfig({ ...readConfig(), serverUrl: url });
  // Relaunch so the new origin is registered in the Chromium switch list,
  // which must happen before the browser process starts.
  app.relaunch();
  isQuitting = true;
  app.exit(0);
});

ipcMain.handle('store:delete', () => {
  const cfg = readConfig();
  delete cfg.serverUrl;
  writeConfig(cfg);
  app.relaunch();
  isQuitting = true;
  app.exit(0);
});

// Mini ↔ main coordination
ipcMain.handle('mini:openMain', async (_event, opts) => {
  const sessionId = opts && typeof opts.sessionId === 'string' ? opts.sessionId : null;
  const win = await ensureMainReady();
  if (!win || !sessionId) return;
  try {
    // The freshly-loaded App.tsx already booted with whatever
    // bunny.activeSessionId was in localStorage. Overwriting + reloading is
    // the simplest way to force it onto the requested session.
    await win.webContents.executeJavaScript(
      `(() => {
        try {
          if (localStorage.getItem('bunny.activeSessionId') !== ${JSON.stringify(sessionId)}) {
            localStorage.setItem('bunny.activeSessionId', ${JSON.stringify(sessionId)});
            window.location.reload();
          }
        } catch (_) {}
      })();`,
      true,
    );
  } catch {
    /* renderer torn down between the await and the call — let it go */
  }
});

ipcMain.handle('mini:close', () => {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.hide();
});

// Hotkey
ipcMain.handle('cfg:hotkey:get', () => {
  const cfg = readConfig();
  return cfg.hotkey === undefined ? DEFAULT_HOTKEY : cfg.hotkey;
});

ipcMain.handle('cfg:hotkey:set', (_event, accelerator) => {
  const value = typeof accelerator === 'string' ? accelerator : '';
  patchConfig({ hotkey: value });
  return applyHotkey(value);
});

// Close-to-tray toggle
ipcMain.handle('cfg:closeToTray:get', () => {
  const cfg = readConfig();
  return cfg.closeToTray === undefined ? true : Boolean(cfg.closeToTray);
});

ipcMain.handle('cfg:closeToTray:set', (_event, value) => {
  patchConfig({ closeToTray: Boolean(value) });
  return true;
});

// ---------------------------------------------------------------------------
// Application menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Quick Chat',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => toggleMiniWindow(),
      },
      {
        label: 'Settings…',
        click: () => openSettingsWindow(),
      },
      { type: 'separator' },
      {
        label: 'Reset Connection',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: resetConnection,
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Tray

function buildTray() {
  // macOS template images are auto-tinted to match the menu-bar palette when
  // the file ends in `Template`. Other platforms get the colour icon.
  const iconPath =
    process.platform === 'darwin'
      ? join(__dirname, 'icons', 'tray-iconTemplate.png')
      : join(__dirname, 'icons', 'tray-icon.png');
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) throw new Error('empty');
  } catch {
    // Fall back to the main app icon if the dedicated tray PNG is missing.
    img = nativeImage.createFromPath(join(__dirname, 'icons', 'icon.png'));
  }
  if (process.platform === 'darwin') img.setTemplateImage(true);

  try {
    tray = new Tray(img);
  } catch (err) {
    // Linux without an AppIndicator-capable session manager will throw. We
    // continue without a tray; the main window is still usable.
    console.warn('[bunny] failed to create tray:', err && err.message);
    tray = null;
    return;
  }

  tray.setToolTip('Bunny');
  refreshTrayMenu();

  // Windows: left-click should open the quick chat for parity with most
  // tray apps. macOS shows the menu by default; Linux varies by DE.
  if (process.platform === 'win32') {
    tray.on('click', () => toggleMiniWindow());
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Bunny',
        click: () => showMainWindow(),
      },
      {
        label: 'New Quick Chat',
        click: () => toggleMiniWindow(),
      },
      { type: 'separator' },
      {
        label: 'Settings…',
        click: () => openSettingsWindow(),
      },
      {
        label: 'Reset Connection',
        click: resetConnection,
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Global hotkey

function applyHotkey(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return false;
  try {
    return globalShortcut.register(accel, () => toggleMiniWindow());
  } catch {
    return false;
  }
}

function resolvedHotkey() {
  const cfg = readConfig();
  return cfg.hotkey === undefined ? DEFAULT_HOTKEY : cfg.hotkey;
}

// ---------------------------------------------------------------------------
// Main window

function createMainWindow() {
  // Grant media and notification permissions for all origins. The
  // permission handler is consulted only after Chromium has accepted the
  // origin as a secure context (via the switch above).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'notifications', 'microphone', 'camera'].includes(permission));
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Bunny',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const serverUrl = readConfig().serverUrl ?? null;
  if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadFile(join(__dirname, 'ui', 'index.html'));
  }

  attachNavigationGuards(win, serverUrl);

  win.webContents.on('context-menu', (_event, params) => {
    const { editFlags, selectionText, isEditable, pageURL } = params;
    const items = [];

    if (win.webContents.canGoBack()) {
      items.push(new MenuItem({ label: 'Back', click: () => win.webContents.goBack() }));
      items.push(new MenuItem({ type: 'separator' }));
    }
    items.push(new MenuItem({ label: 'Reload', click: () => win.webContents.reload() }));

    const externalUrl = params.linkURL || pageURL;
    if (externalUrl && !externalUrl.startsWith('file:') && !externalUrl.startsWith('about:')) {
      items.push(
        new MenuItem({
          label: 'Open in Browser',
          click: () => shell.openExternal(externalUrl),
        }),
      );
    }

    const hasText = selectionText.length > 0;
    if (isEditable || hasText) {
      items.push(new MenuItem({ type: 'separator' }));
      if (isEditable) items.push(new MenuItem({ label: 'Cut', role: 'cut', enabled: editFlags.canCut }));
      items.push(new MenuItem({ label: 'Copy', role: 'copy', enabled: editFlags.canCopy && hasText }));
      if (isEditable) items.push(new MenuItem({ label: 'Paste', role: 'paste', enabled: editFlags.canPaste }));
    }

    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('close', (event) => {
    if (isQuitting) return;
    const cfg = readConfig();
    const closeToTray = cfg.closeToTray === undefined ? true : Boolean(cfg.closeToTray);
    if (closeToTray && tray) {
      event.preventDefault();
      win.hide();
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
    }
  });

  win.on('show', () => {
    if (process.platform === 'darwin' && app.dock) app.dock.show();
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  return win;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    // ready-to-show fires win.show() asynchronously — don't fight it here.
    return mainWindow;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

/**
 * Show the main window and resolve once its renderer has loaded. Used by
 * `mini:openMain` so a freshly-created window doesn't race the
 * `executeJavaScript` injection that swaps `bunny.activeSessionId`.
 */
async function ensureMainReady() {
  const win = showMainWindow();
  if (!win || win.isDestroyed()) return null;
  const wc = win.webContents;
  if (wc.isLoading()) {
    await new Promise((resolve) => {
      const onDone = () => {
        wc.removeListener('did-finish-load', onDone);
        wc.removeListener('did-fail-load', onDone);
        resolve();
      };
      wc.once('did-finish-load', onDone);
      wc.once('did-fail-load', onDone);
    });
  }
  if (win.isDestroyed()) return null;
  return win;
}

// ---------------------------------------------------------------------------
// Mini (quick-chat) window

function createMiniWindow() {
  const cfg = readConfig();
  if (!cfg.serverUrl) {
    // Without a connection there is no UI to render — nudge the user to
    // complete setup via the main window first.
    showMainWindow();
    return null;
  }
  const win = new BrowserWindow({
    width: 520,
    height: 660,
    minWidth: 420,
    minHeight: 460,
    title: 'Bunny Quick Chat',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--bunny-mini'],
    },
  });

  let url;
  try {
    url = new URL(cfg.serverUrl);
    url.searchParams.set('mini', '1');
  } catch {
    showMainWindow();
    win.destroy();
    return null;
  }
  win.loadURL(url.toString());
  attachNavigationGuards(win, cfg.serverUrl);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (miniWindow === win) miniWindow = null;
  });

  miniWindow = win;
  return win;
}

function toggleMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    if (miniWindow.isVisible() && miniWindow.isFocused()) {
      miniWindow.hide();
    } else {
      if (miniWindow.isMinimized()) miniWindow.restore();
      miniWindow.show();
      miniWindow.focus();
    }
    return;
  }
  createMiniWindow();
}

// ---------------------------------------------------------------------------
// Settings window

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 460,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Bunny Settings',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(join(__dirname, 'ui', 'settings.html'));
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  settingsWindow = win;
}

// ---------------------------------------------------------------------------
// Reset connection (also closes mini, since it depends on serverUrl)

function resetConnection() {
  const cfg = readConfig();
  delete cfg.serverUrl;
  writeConfig(cfg);
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// App lifecycle

app.whenReady().then(() => {
  buildMenu();
  buildTray();
  createMainWindow();
  applyHotkey(resolvedHotkey());
});

app.on('activate', () => {
  // macOS: re-open the main window when the dock icon is clicked.
  showMainWindow();
});

app.on('window-all-closed', () => {
  // The tray keeps the process alive in the background. Without a tray
  // (e.g. Linux DE without indicator support) we behave like a normal app.
  if (!tray || isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
