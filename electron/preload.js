'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getServerUrl:    ()    => ipcRenderer.invoke('store:get'),
  setServerUrl:    (url) => ipcRenderer.invoke('store:set', url),
  deleteServerUrl: ()    => ipcRenderer.invoke('store:delete'),

  // Mini-window awareness — preload reads process.argv synchronously so the
  // renderer can branch immediately without an extra IPC round-trip.
  isMiniWindow: () => process.argv.includes('--bunny-mini'),

  // Mini ↔ main coordination
  openMainWindow:  (opts) => ipcRenderer.invoke('mini:openMain', opts ?? {}),
  closeMiniWindow: () => ipcRenderer.invoke('mini:close'),

  // Hotkey / closeToTray (used by the Settings window and setup form)
  getHotkey:      () => ipcRenderer.invoke('cfg:hotkey:get'),
  setHotkey:      (a) => ipcRenderer.invoke('cfg:hotkey:set', a ?? ''),
  getCloseToTray: () => ipcRenderer.invoke('cfg:closeToTray:get'),
  setCloseToTray: (v) => ipcRenderer.invoke('cfg:closeToTray:set', Boolean(v)),
});
