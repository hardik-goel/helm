import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from 'electron';
import type { Server } from 'node:http';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readPorts, HELM_HOME } from './config.js';
import { serveConsole } from './static-server.js';
import { startBridge, type BridgeHandle } from './bridge-process.js';

const PACKAGED = app.isPackaged;
/**
 * Everything the app ships — the bundled daemon, the exported console, the
 * migrations, the tray icon — sits together. In development that is the build
 * folder this file was written into; in the packaged app it is Resources.
 */
const RESOURCES = PACKAGED ? join(app.getAppPath(), 'build') : __dirname;

const ports = readPorts();
const BRIDGE_URL = `http://127.0.0.1:${ports.bridgePort}`;
const CONSOLE_URL = `http://127.0.0.1:${ports.consolePort}`;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: BridgeHandle | null = null;
let httpServer: Server | null = null;
let socket: WebSocket | null = null;
let quitting = false;
let killed = false;
let pendingGate = 0;
const log: string[] = [];

/* ------------------------------------------------------------------ */

function remember(line: string): void {
  log.push(line);
  if (log.length > 400) log.shift();
  process.stdout.write(`[bridge] ${line}\n`);
}

async function waitForBridge(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`);
      if (res.ok) {
        const body = (await res.json()) as { killed?: boolean };
        killed = !!body.killed;
        return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------------------------- window ------------------------------ */

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'Helm',
    show: false,
    webPreferences: {
      // The console is an ordinary web app talking to the daemon over HTTP.
      // It has no business touching Node, so it does not get to.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win?.show());
  void win.loadURL(CONSOLE_URL);

  // The cockpit is the only thing allowed to render in this window. Anything
  // else — a link an agent surfaced, say — opens in the real browser.
  const isOurs = (url: string) => url.startsWith(CONSOLE_URL);
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    // Closing the window leaves the fleet running and the tray in place, which
    // is the point of a menu-bar app. Quit from the tray or ⌘Q.
    if (!quitting && process.platform === 'darwin') {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow(): void {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

/**
 * A packaged app needs a real menu — for copy and paste in the console's text
 * fields as much as anything. The kill switch is in here too, with the same
 * shortcut the console binds, so it works whatever has focus.
 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: 'Helm',
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      {
        label: 'Fleet',
        submenu: [
          {
            label: 'Kill fleet now',
            accelerator: 'CommandOrControl+Shift+K',
            click: () => void setFleet(true),
          },
          { label: 'Resume fleet', click: () => void setFleet(false) },
          { type: 'separator' },
          { label: 'Open Helm folder', click: () => void shell.openPath(HELM_HOME) },
          { label: 'Copy daemon log', click: copyLog },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Reload cockpit', accelerator: 'CommandOrControl+R', click: reloadConsole },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

function reloadConsole(): void {
  showWindow();
  win?.loadURL(CONSOLE_URL).catch(() => {});
}

/* ----------------------------- tray ------------------------------- */

function trayIcon(): Electron.NativeImage {
  const file = join(RESOURCES, 'assets', 'trayTemplate.png');
  const img = nativeImage.createFromPath(file);
  if (!img.isEmpty()) {
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createEmpty();
}

function refreshTray(): void {
  if (!tray) return;

  const status = killed
    ? 'FLEET KILLED'
    : pendingGate > 0
      ? `${pendingGate} waiting for you`
      : 'running';

  tray.setToolTip(`Helm — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Helm — ${status}`, enabled: false },
      { type: 'separator' },
      { label: 'Open cockpit', click: showWindow },
      {
        label: pendingGate > 0 ? `Review ${pendingGate} approval(s)` : 'Approval gate',
        enabled: pendingGate > 0,
        click: () => {
          showWindow();
          win?.webContents.executeJavaScript(
            "document.querySelectorAll('.tab').forEach(b=>{if(b.textContent.trim().startsWith('gate'))b.click()})",
          );
        },
      },
      { type: 'separator' },
      killed
        ? { label: 'Resume fleet', click: () => void setFleet(false) }
        : { label: 'Kill fleet now', click: () => void setFleet(true) },
      { type: 'separator' },
      { label: 'Reload cockpit', click: reloadConsole },
      { label: 'Open Helm folder', click: () => void shell.openPath(HELM_HOME) },
      { label: 'Copy daemon log', click: () => copyLog() },
      { type: 'separator' },
      { label: 'Quit Helm', click: () => app.quit() },
    ]),
  );
}

async function setFleet(kill: boolean): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}/fleet/${kill ? 'kill' : 'resume'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CONSOLE_URL },
      body: JSON.stringify({ reason: 'menu bar' }),
    });
    killed = kill;
    refreshTray();
    new Notification({
      title: kill ? 'Fleet stopped' : 'Fleet resumed',
      body: kill
        ? 'Every agent has been stopped. Nothing will wake until you resume.'
        : 'Agents will wake on their heartbeats again.',
    }).show();
  } catch (err) {
    dialog.showErrorBox('Helm', `Could not reach the daemon: ${(err as Error).message}`);
  }
}

function copyLog(): void {
  void import('electron').then(({ clipboard }) => {
    clipboard.writeText(log.join('\n'));
  });
}

/* ------------------------- notifications -------------------------- */

/**
 * The tray watches the same websocket the console does, so an approval that
 * needs a human reaches you even when the window is closed. Without this, a
 * blocked agent waits silently until you happen to look.
 */
function watchFleet(): void {
  const connect = () => {
    if (quitting) return;
    socket = new WebSocket(`ws://127.0.0.1:${ports.bridgePort}/ws`, {
      origin: CONSOLE_URL,
    });

    socket.on('open', () => socket?.send(JSON.stringify({ type: 'hello' })));
    socket.on('close', () => {
      socket = null;
      if (!quitting) setTimeout(connect, 2000);
    });
    socket.on('error', () => socket?.close());

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; item?: { kind?: string; label?: string }; killed?: boolean; pendingGate?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'gate.new' && msg.item) {
        pendingGate += 1;
        refreshTray();
        const n = new Notification({
          title: `Approval needed — ${msg.item.kind}`,
          body: msg.item.label ?? 'An agent is waiting for your decision.',
          urgency: 'critical',
        });
        n.on('click', showWindow);
        n.show();
      } else if (msg.type === 'gate.decided') {
        pendingGate = Math.max(0, pendingGate - 1);
        refreshTray();
      } else if (msg.type === 'fleet.state') {
        killed = !!msg.killed;
        pendingGate = msg.pendingGate ?? pendingGate;
        refreshTray();
      }
    });
  };
  connect();
}

/* ------------------------------ boot ------------------------------ */

async function boot(): Promise<void> {
  remember(`helm desktop starting — packaged=${PACKAGED} resources=${RESOURCES}`);
  try {
    bridge = startBridge({
      entry: join(RESOURCES, 'bridge.cjs'),
      migrationsDir: join(RESOURCES, 'drizzle'),
      packaged: PACKAGED,
      onLog: remember,
      onExit: (code) => {
        if (quitting) return;
        dialog.showErrorBox(
          'Helm daemon stopped',
          `The supervisor exited (code ${code}). Your agents are not running.\n\n` +
            `Last output:\n${log.slice(-12).join('\n')}`,
        );
      },
    });
  } catch (err) {
    dialog.showErrorBox('Helm could not start', (err as Error).message);
    app.quit();
    return;
  }

  if (!(await waitForBridge())) {
    const portLine = log.find((l) => l.includes('already in use'));
    dialog.showErrorBox(
      'Helm could not start',
      portLine
        ? `Port ${ports.bridgePort} is already in use. Helm may already be running, ` +
            `or a \`pnpm helm\` session is open in a terminal.`
        : `The daemon did not come up within 30 seconds.\n\n${log.slice(-12).join('\n')}`,
    );
    app.quit();
    return;
  }

  try {
    httpServer = await serveConsole(join(RESOURCES, 'console'), ports.consolePort);
  } catch (err) {
    dialog.showErrorBox(
      'Helm could not start',
      `Port ${ports.consolePort} is already in use, so the cockpit cannot open. ` +
        `Close the other Helm (or \`pnpm helm\`) and try again.\n\n${(err as Error).message}`,
    );
    app.quit();
    return;
  }

  tray = new Tray(trayIcon());
  tray.on('click', showWindow);
  refreshTray();
  buildAppMenu();
  watchFleet();
  createWindow();
}

/* --------------------------- lifecycle ---------------------------- */

// Two copies of Helm would mean two supervisors against one database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  app.on('window-all-closed', () => {
    // Deliberately does not quit on macOS: the fleet keeps running in the tray.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;

    socket?.close();
    httpServer?.close();
    // Stopping the daemon stops every agent it owns. Quitting Helm must not
    // leave orphaned sessions running against your repos.
    await bridge?.stop();
    app.exit(0);
  });
}
