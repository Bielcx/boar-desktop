/**
 * The native menu (hidden until Alt, like most Windows apps). The app's own shortcuts are handled in the page
 * (src/ui-android/ChatScreen.tsx); these items only list them, with registerAccelerator: false so the key still
 * reaches the page, and clicking one sends that same key to the page. Replaces Electron's default menu, whose
 * Ctrl+R reload would throw away an answer being written; reload and DevTools stay in development only.
 */
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

export function appMenu(getWin: () => BrowserWindow | null, dev: boolean): Menu {
  const press = (keyCode: string, modifiers: Array<"control"> = []) => () =>
    getWin()?.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  const shortcut = (id: string, label: string, accelerator: string, keyCode: string, ctrl: boolean): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    registerAccelerator: false,
    click: press(keyCode, ctrl ? ["control"] : []),
  });
  const template: MenuItemConstructorOptions[] = [
    { label: "&File", submenu: [shortcut("new-chat", "New chat", "CmdOrCtrl+N", "N", true), { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
    {
      label: "&Chat",
      submenu: [
        shortcut("focus-input", "Ask a question", "CmdOrCtrl+K", "K", true),
        shortcut("stop", "Stop the answer", "Esc", "Escape", false),
      ],
    },
    {
      label: "&View",
      submenu: [
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(dev ? [{ type: "separator" } as const, { role: "reload" } as const, { role: "toggleDevTools" } as const] : []),
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
