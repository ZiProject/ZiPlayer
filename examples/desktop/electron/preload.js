// Electron Preload script
// Preserves context isolation by exposing only safe minimal properties to the window
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktopEnv", {
	platform: process.platform,
	arch: process.arch,
});
