'use strict';

const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// ---------------------------------------------------------------------------
// Config storage

const CONFIG_FILE = join(app.getPath('userData'), 'config.json');

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

// ---------------------------------------------------------------------------
// IPC

ipcMain.handle('store:get', () => readConfig().serverUrl ?? null);

ipcMain.handle('store:set', (_event, url) => {
  writeConfig({ serverUrl: url });
  // Relaunch so the new origin is registered in the Chromium switch list,
  // which must happen before the browser process starts.
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('store:delete', () => {
  writeConfig({});
  app.relaunch();
  app.exit(0);
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
        label: 'Reset Connection',
        accelerator: 'CmdOrCtrl+Shift+R',
        click() {
          writeConfig({});
          app.relaunch();
          app.exit(0);
        },
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
// Window

function createWindow() {
  // Grant media and notification permissions for all origins.
  // setPermissionRequestHandler approves the request after Chromium has
  // determined the origin qualifies as a secure context (via the switch above).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'notifications', 'microphone', 'camera'].includes(permission));
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Bunny',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required so the preload script can require('electron').
      sandbox: false,
      // Allows HTTP pages to use media APIs once the origin is registered
      // as a secure context via the Chromium switch.
      allowRunningInsecureContent: true,
    },
  });

  const serverUrl = readConfig().serverUrl ?? null;
  if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadFile(join(__dirname, 'ui', 'index.html'));
  }

  // Layer 1: intercept window.location.href assignments and form submits.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url, serverUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Layer 2: intercept window.open() and <a target="_blank"> clicks.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url, serverUrl)) {
      shell.openExternal(url);
    }
    return { action: 'deny' }; // Never open a second BrowserWindow.
  });

  // Inject a floating reload button so dev changes can be picked up without
  // needing the keyboard shortcut or right-click menu.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (function () {
        if (document.getElementById('__electron-reload-btn__')) return;
        const btn = document.createElement('button');
        btn.id = '__electron-reload-btn__';
        btn.title = 'Reload';
        btn.textContent = '↺';
        Object.assign(btn.style, {
          position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647',
          width: '30px', height: '30px', borderRadius: '50%', border: 'none',
          background: 'rgba(0,0,0,0.18)', color: '#fff', fontSize: '17px',
          cursor: 'pointer', opacity: '0.55', transition: 'opacity 0.15s',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          lineHeight: '1', padding: '0',
        });
        btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.55'; });
        btn.addEventListener('click', () => { location.reload(); });
        document.body.appendChild(btn);
      })();
    `).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// App lifecycle

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
