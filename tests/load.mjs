// Loads a browser script from assets/ into a bare context so its pure functions can be tested with node --test (no build, no browser).
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
export function loadBHL(...files) {
  const win = { BHL_CONFIG: {} }, ctx = vm.createContext({ window: win, document: {}, localStorage: {}, navigator: {}, console, Intl, Date, Math });
  for (const f of files) vm.runInContext(fs.readFileSync(fileURLToPath(new URL(`../assets/${f}`, import.meta.url)), "utf8"), ctx);
  return win.BHL;
}
