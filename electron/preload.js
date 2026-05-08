'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getServerUrl:    ()    => ipcRenderer.invoke('store:get'),
  setServerUrl:    (url) => ipcRenderer.invoke('store:set', url),
  deleteServerUrl: ()    => ipcRenderer.invoke('store:delete'),
});
