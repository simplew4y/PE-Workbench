import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const menu = await readFile(new URL("./PeAccountMenu.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("opening personal settings dismisses session information and mobile top panels", () => {
  assert.match(menu, /if \(!menuOpen\) window.dispatchEvent\(new Event\(PE_OPEN_ACCOUNT_MENU_EVENT\)\)/);
  assert.match(shell, /const closeTopPanels = \(\) => \{\s*setActiveTopPanel\(null\);\s*setMobileToolbarMoreOpen\(false\);/);
  assert.match(shell, /addEventListener\(PE_OPEN_ACCOUNT_MENU_EVENT, closeTopPanels\)/);
  assert.match(shell, /removeEventListener\(PE_OPEN_ACCOUNT_MENU_EVENT, closeTopPanels\)/);
});

test("account settings use a portalled modal with managed dismissal and focus", () => {
  assert.match(menu, /<Dialog.Root open onOpenChange=/);
  assert.match(menu, /<Dialog.Portal>[\s\S]*<Dialog.Backdrop[\s\S]*<Dialog.Popup/);
  assert.match(menu, /finalFocus=/);
  assert.match(menu, /<Dialog.Title/);
  assert.match(menu, /<Dialog.Description/);
  const panelLayer = Number(shell.match(/maxHeight: `calc\(100dvh[\s\S]*?zIndex: (\d+)/)?.[1]);
  const backdropLayer = Number(menu.match(/<Dialog.Backdrop className="[^"]*z-\[(\d+)\]/)?.[1]);
  const popupLayer = Number(menu.match(/<Dialog.Popup[\s\S]*?className="[^"]*z-\[(\d+)\]/)?.[1]);
  assert.ok(backdropLayer > panelLayer);
  assert.ok(popupLayer > backdropLayer);
});
