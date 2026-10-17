/**
 * Dev helper: run a fake Moonraker and a fake OctoPrint on this machine so the send flow
 * can be clicked through without real printers.  npx tsx scripts/fake-printers.ts
 * Moonraker on 127.0.0.1:7125 (if free), OctoPrint on 127.0.0.1:5000 with API key "dev-octo-key".
 */
import { fakeMoonraker, fakeOctoPrint } from "../test/fakes.ts";

const moon = await fakeMoonraker(7125);
const octo = await fakeOctoPrint("dev-octo-key", 5000);
console.log(`fake Moonraker on 127.0.0.1:${moon.port}, fake OctoPrint on 127.0.0.1:${octo.port} (API key dev-octo-key)`);
setInterval(() => {
  for (const [name, f] of [["moonraker", moon], ["octoprint", octo]] as const) if (f.uploads.length) console.log(name, "received", f.uploads.map((u) => u.name));
}, 5000);
