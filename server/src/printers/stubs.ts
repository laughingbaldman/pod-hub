import { AdapterError, type PrinterAdapter } from "./types.js";

/**
 * Bambu Lab LAN (stub). Real control needs MQTT over TLS on 8883 (user "bblp", the
 * printer's access code) plus FTPS on 990 for the upload, and on current firmware the
 * printer's LAN-only / developer mode. Left as a stub until a Bambu printer is confirmed.
 */
export const bambu: PrinterAdapter = {
  type: "bambu",
  label: "Bambu Lab LAN (not yet supported)",
  defaultPort: 8883,
  implemented: false,
  secretFields: [
    { key: "serial", label: "Serial number", required: true },
    { key: "accessCode", label: "LAN access code", required: true },
  ],
  async status() {
    return { state: "unknown", message: "Bambu LAN support is not built yet." };
  },
  async send() {
    throw new AdapterError("Bambu LAN send is not built yet. Use the SD card or Bambu's own software for now.");
  },
};

/** A machine the Hub only tracks (old printers, scanners). No network control. */
export const manual: PrinterAdapter = {
  type: "manual",
  label: "Manual (no network control)",
  defaultPort: 80,
  implemented: false,
  secretFields: [],
  async status() {
    return { state: "unknown", message: "Tracked by hand." };
  },
  async send() {
    throw new AdapterError("This machine is manual. Download the file and load it by hand.");
  },
};
