/**
 * MU/TH/UR Terminal
 * A fully interactive MU/TH/UR terminal for Alien RPG Evolved.
 *
 * Architecture:
 *  - A single world-scoped setting ("transcript") is the source of truth for the
 *    terminal log. Only the GM's client ever writes to it (Foundry enforces this
 *    server-side for world-scope settings), which keeps every connected client in sync
 *    for free via the "updateSetting" hook.
 *  - Players cannot write the setting directly, so when a player types a command it is
 *    (a) echoed immediately in their own window as a "pending" line for instant feedback,
 *    and (b) sent to the GM over the module socket. The GM's console lists every incoming
 *    query and lets the GM type MU/TH/UR's reply, targeted at one player or broadcast to all.
 *  - Each transcript entry carries a "scope" (either "all" or an array of user IDs) so the
 *    GM can whisper a reply to a single terminal or address the whole crew at once.
 */

const MODULE_ID = "muthur-terminal";
const SOCKET = `module.${MODULE_ID}`;

/** Active player session (synced to all clients via socket). */
const activeSession = {
  userId: null,
  userName: null,
  spectatorIds: []
};

/** When set, this client is spectating another player's terminal. */
let spectatorWatchUserId = null;

let pendingSpectatorRequestId = null;

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTranscript() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, "transcript") ?? []);
}

async function pushTranscriptEntry(entry) {
  if (!game.user.isGM) return;
  const log = getTranscript();
  log.push(entry);
  // Keep the persisted log from growing without bound.
  while (log.length > 500) log.shift();
  await game.settings.set(MODULE_ID, "transcript", log);
}

async function clearTranscript() {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, "transcript", []);
}

function isVisibleToMe(entry) {
  if (game.user.isGM) return true;
  const userId = spectatorWatchUserId ?? game.user.id;
  if (entry.scope === "all") return true;
  if (Array.isArray(entry.scope) && entry.scope.includes(userId)) return true;
  if (entry.authorId === userId) return true;
  return false;
}

function formatEntryHtml(entry, { showAuthor = false } = {}) {
  let prefix = "";
  if (entry.type === "input") {
    const who = showAuthor && entry.authorName ? `<span class="muthur-author">[${escapeHtml(entry.authorName)}]</span> ` : "";
    prefix = `<span class="muthur-caret">&gt;</span> ${who}`;
  } else if (entry.type === "output") {
    prefix = `<span class="muthur-tag">${escapeHtml(localize("MUTHUR.TagMuthur"))}</span> `;
  } else if (entry.type === "system") {
    prefix = `<span class="muthur-tag muthur-sys">${escapeHtml(localize("MUTHUR.TagSystem"))}</span> `;
  }
  const body = escapeHtml(normalizeNewlines(entry.text ?? "")).replace(/\n/g, "<br>");
  return prefix + body;
}

function localize(key, data = {}) {
  return game.i18n.format(key, data);
}

/** Resolve world setting text; handles empty values and legacy i18n keys saved before translations loaded. */
function resolveLocalizedText(value, fallbackKey) {
  const raw = String(value ?? "").trim();
  const key = raw || fallbackKey;
  if (key.startsWith("MUTHUR.")) {
    const resolved = localize(key);
    if (resolved !== key) return normalizeNewlines(resolved);
  }
  return normalizeNewlines(raw || localize(fallbackKey));
}

/** Normalize line breaks from settings storage, JSON, or Windows-style newlines. */
function normalizeNewlines(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\n/g, "\n");
}

/** Read a multiline world text setting, restoring i18n newlines if a single-line input flattened them. */
function readMultilineSetting(settingKey, fallbackKey) {
  const fallback = normalizeNewlines(localize(fallbackKey));
  const stored = resolveLocalizedText(game.settings.get(MODULE_ID, settingKey), fallbackKey);
  if (!stored) return fallback;
  if (fallback.includes("\n") && !stored.includes("\n")) {
    const flatten = (s) => s.replace(/\s+/g, " ").trim();
    if (flatten(stored) === flatten(fallback.replace(/\n/g, " "))) return fallback;
  }
  return stored;
}

function localizedDefault(key) {
  return normalizeNewlines(game.i18n.localize(key));
}

function registerMultilineWorldSetting(key, nameKey, hintKey, defaultKey) {
  const Field = foundry.data?.fields?.StringField;
  game.settings.register(MODULE_ID, key, {
    name: nameKey,
    hint: hintKey,
    scope: "world",
    config: true,
    type: Field ? new Field({ blank: true, trim: false }) : String,
    default: localizedDefault(defaultKey)
  });
}

function registerSingleLineWorldSetting(key, nameKey, hintKey, defaultKey) {
  const Field = foundry.data?.fields?.StringField;
  game.settings.register(MODULE_ID, key, {
    name: nameKey,
    hint: hintKey,
    scope: "world",
    config: true,
    type: Field ? new Field({ blank: true, trim: false }) : String,
    default: localizedDefault(defaultKey)
  });
}

const MULTILINE_SETTING_KEYS = ["bootText", "statusCustomText"];

function getSettingsConfigRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function findSettingControl(root, key) {
  const settingId = `${MODULE_ID}.${key}`;
  const group =
    root.querySelector(`div[data-setting-id="${settingId}"]`) ??
    root.querySelector(`[data-setting-id="${settingId}"]`);
  if (group) {
    const control = group.querySelector("input:not([type='hidden']), textarea");
    if (control) return control;
  }
  return (
    root.querySelector(`textarea[name="${settingId}"]`) ??
    root.querySelector(`input[name="${settingId}"]`) ??
    root.querySelector(`textarea[name="${key}"]`) ??
    root.querySelector(`input[name="${key}"]`) ??
    root.querySelector(`#settings-config-${CSS.escape(settingId)}`)
  );
}

function upgradeMultilineSettingInputs(root) {
  for (const key of MULTILINE_SETTING_KEYS) {
    const control = findSettingControl(root, key);
    if (!control || control.tagName === "TEXTAREA") continue;

    const value = normalizeNewlines(control.value || game.settings.get(MODULE_ID, key) || "");
    const textarea = document.createElement("textarea");
    for (const attr of ["name", "id", "class"]) {
      const val = control.getAttribute(attr);
      if (val) textarea.setAttribute(attr, val);
    }
    textarea.value = value;
    textarea.rows = Math.max(3, value.split("\n").length + 1);
    textarea.style.width = "100%";
    textarea.style.minHeight = "4.5em";
    textarea.style.resize = "vertical";
    control.replaceWith(textarea);
  }
}

function bindSettingsConfigTextareas() {
  const runUpgrade = (root, app) => {
    const scope =
      root ??
      app?.element ??
      document.querySelector(".application.settings-config") ??
      document.querySelector('[data-application-class="SettingsConfig"]');
    if (scope) upgradeMultilineSettingInputs(scope);
  };

  Hooks.on("renderSettingsConfig", (app, html) => {
    queueMicrotask(() => runUpgrade(getSettingsConfigRoot(html), app));
  });

  Hooks.on("renderApplicationV2", (app, element) => {
    if (app?.constructor?.name !== "SettingsConfig") return;
    queueMicrotask(() => runUpgrade(element, app));
  });
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*";

const BOOT_SEQUENCE_KEYS = [
  "MUTHUR.Boot.Initialize",
  "MUTHUR.Boot.CoreSystems",
  "MUTHUR.Boot.Memory",
  "MUTHUR.Boot.Neural",
  "MUTHUR.Boot.Protocols",
  "MUTHUR.Boot.LifeSupport",
  "MUTHUR.Boot.Security",
  "MUTHUR.Boot.Network",
  "MUTHUR.Boot.SystemReady",
  "MUTHUR.Boot.Online",
  "MUTHUR.Boot.InterfaceReady"
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTypewriterEnabled() {
  try {
    return game.settings.get(MODULE_ID, "enableTypewriter");
  } catch {
    return true;
  }
}

function isScrambleEnabled() {
  try {
    return game.settings.get(MODULE_ID, "enableScrambleTypewriter");
  } catch {
    return true;
  }
}

function isScanlineEnabled() {
  try {
    return game.settings.get(MODULE_ID, "enableScanline");
  } catch {
    return true;
  }
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
    : "51, 255, 92";
}

async function playScanlineSweep(lineEl, color = "#33ff5c") {
  if (!isScanlineEnabled()) return;
  const size = Number(game.settings.get(MODULE_ID, "scanlineSize")) || 30;
  const rgb = hexToRgb(color);
  const sweep = document.createElement("div");
  sweep.className = "muthur-scanline-sweep";
  sweep.style.width = `${size}px`;
  sweep.style.background = `radial-gradient(circle, ${color} 50%, rgba(${rgb}, 0.7) 70%, transparent 90%)`;
  sweep.style.boxShadow = `0 0 10px ${color}, 0 0 20px ${color}`;
  lineEl.style.position = "relative";
  lineEl.appendChild(sweep);
  try {
    await sweep.animate(
      [
        { left: "100%", filter: "blur(2px) brightness(1.5)" },
        { left: `-${size}px`, filter: "blur(3px) brightness(2)" }
      ],
      { duration: 200, easing: "linear" }
    ).finished;
  } finally {
    sweep.remove();
  }
}

async function typewritePlain(targetEl, text, speedMs, isActive = () => true, soundMode = "com") {
  for (let i = 0; i < text.length; i++) {
    if (!isActive()) return;
    const ch = text[i];
    if (soundMode === "type" && ch !== "\n") MuthurSounds.playTypeSound();
    else if (soundMode === "com" && ch === " ") MuthurSounds.playComSoundThrottled();
    targetEl.appendChild(document.createTextNode(ch));
    await delay(speedMs);
  }
}

async function typewriteScramble(targetEl, text, speedMs, isActive = () => true, soundMode = "com") {
  let current = "";
  for (let i = 0; i < text.length; i++) {
    if (!isActive()) return;
    for (let j = 0; j < 3; j++) {
      if (!isActive()) return;
      const randomChar = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
      targetEl.textContent = current + randomChar;
      await delay(speedMs / 3);
    }
    current += text[i];
    targetEl.textContent = current;
    if (soundMode === "type") MuthurSounds.playTypeSound();
    else if (soundMode === "com" && text[i] === " ") MuthurSounds.playComSoundThrottled();
    await delay(speedMs);
  }
}

async function animateTerminalText(lineEl, { text, type, speed, scrollFn, isActive }) {
  const lines = normalizeNewlines(text).split("\n");
  const color = type === "boot" ? "#1fae40" : "#33ff5c";
  const scramble = isScrambleEnabled();
  const playReply = type === "output" || type === "boot";
  const soundMode = type === "boot" ? "none" : "com";

  lineEl.innerHTML = "";
  if (type === "output") {
    const tag = document.createElement("span");
    tag.className = "muthur-tag";
    tag.textContent = localize("MUTHUR.TagMuthur");
    lineEl.appendChild(tag);
    lineEl.appendChild(document.createTextNode(" "));
  }

  const body = document.createElement("div");
  body.className = "muthur-line-body";
  lineEl.appendChild(body);

  if (playReply) MuthurSounds.startReplySound();
  try {
    for (const lineText of lines) {
      if (!isActive()) return;
      const row = document.createElement("div");
      row.className = "muthur-line-row";
      body.appendChild(row);

      await playScanlineSweep(row, color);
      if (!isActive()) return;

      if (scramble) await typewriteScramble(row, lineText, speed, isActive, soundMode);
      else await typewritePlain(row, lineText, speed, isActive, soundMode);

      scrollFn?.();
    }
  } finally {
    if (playReply) MuthurSounds.stopReplySound();
    scrollFn?.();
  }
}

function normalizeCommand(text) {
  return String(text ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function getStatusResponseText() {
  const preset = game.settings.get(MODULE_ID, "statusPreset") ?? "normal";
  if (preset === "custom") {
    const custom = readMultilineSetting("statusCustomText", "MUTHUR.SettingStatusCustomDefault").trim();
    return custom || localize("MUTHUR.Commands.status.presets.normal");
  }
  return localize(`MUTHUR.Commands.status.presets.${preset}`);
}

function getMissionTimeText() {
  const components = game.time?.components ?? {};
  const hour = String(components.hour ?? 0).padStart(2, "0");
  const minute = String(components.minute ?? 0).padStart(2, "0");
  const second = String(components.second ?? 0).padStart(2, "0");
  const day = components.day ?? 1;
  const month = components.month ?? 1;
  const year = components.year ?? 2183;
  return localize("MUTHUR.Commands.time", { hour, minute, second, day, month, year });
}

function getCrewManifestText() {
  const crew = game.users
    .filter((u) => !u.isGM)
    .map((u) => {
      const designation = (u.character?.name ?? u.name).toUpperCase();
      const status = u.active ? localize("MUTHUR.Commands.crewActive") : localize("MUTHUR.Commands.crewInactive");
      return localize("MUTHUR.Commands.crewLine", { designation, status });
    });
  if (!crew.length) return localize("MUTHUR.Commands.crewEmpty");
  return `${localize("MUTHUR.Commands.crewHeader")}\n${crew.join("\n")}`;
}

function getSceneLocationText() {
  const scene = game.scenes?.current;
  if (!scene) return localize("MUTHUR.Commands.locationUnknown");
  return localize("MUTHUR.Commands.location", { scene: scene.name.toUpperCase() });
}

function getVersionText() {
  const manifest = game.modules.get(MODULE_ID)?.version ?? "unknown";
  return localize("MUTHUR.Commands.version", { version: manifest });
}

function getSpecialOrdersText() {
  return localize("MUTHUR.Commands.specialOrders");
}

/**
 * Built-in MU/TH/UR command handlers. Return null to fall through to the GM.
 * @param {string} text Raw player input
 * @returns {{ text: string, type?: string } | null}
 */
function resolveScriptedCommand(text) {
  const cmd = normalizeCommand(text);
  const handlers = {
    STATUS: () => ({ text: getStatusResponseText(), type: "output" }),
    TIME: () => ({ text: getMissionTimeText(), type: "output" }),
    DATE: () => ({ text: getMissionTimeText(), type: "output" }),
    CREW: () => ({ text: getCrewManifestText(), type: "output" }),
    "CREW MANIFEST": () => ({ text: getCrewManifestText(), type: "output" }),
    MANIFEST: () => ({ text: getCrewManifestText(), type: "output" }),
    LOCATION: () => ({ text: getSceneLocationText(), type: "output" }),
    LOC: () => ({ text: getSceneLocationText(), type: "output" }),
    VERSION: () => ({ text: getVersionText(), type: "output" }),
    INTERFACE: () => ({ text: getVersionText(), type: "output" }),
    ORDERS: () => ({ text: getSpecialOrdersText(), type: "output" }),
    "SPECIAL ORDERS": () => ({ text: getSpecialOrdersText(), type: "output" }),
    "SPECIAL ORDER": () => ({ text: getSpecialOrdersText(), type: "output" })
  };

  const handler = handlers[cmd];
  return handler ? handler() : null;
}

/* -------------------------------------------- */
/*  Terminal sounds (ported from alien-mu-th-ur) */
/* -------------------------------------------- */

const MuthurSounds = {
  _replyAudio: null,
  _continueReply: false,
  _lastComAt: 0,

  _base(...parts) {
    return `modules/${MODULE_ID}/sounds/${parts.join("/")}`;
  },

  isEnabled() {
    try {
      return game.settings.get(MODULE_ID, "enableTypingSounds");
    } catch {
      return true;
    }
  },

  volume() {
    try {
      return Number(game.settings.get(MODULE_ID, "typingSoundVolume")) || 0.2;
    } catch {
      return 0.2;
    }
  },

  async _play(src, { loop = false } = {}) {
    if (!this.isEnabled()) return;
    const volume = this.volume();
    try {
      if (typeof AudioHelper !== "undefined" && AudioHelper?.play) {
        return await AudioHelper.play({ src, volume, autoplay: true, loop }, true);
      }
    } catch {
      /* fall through */
    }
    const audio = new Audio(src);
    audio.volume = volume;
    audio.loop = loop;
    return audio.play();
  },

  playTypeSound() {
    const n = Math.floor(Math.random() * 34) + 1;
    return this._play(this._base("keypress", `Keypress_${n}.ogg`));
  },

  playReturnSound() {
    const n = Math.floor(Math.random() * 19) + 1;
    return this._play(this._base("Key press return", `Return_beep_${n}.ogg`));
  },

  playErrorSound() {
    return this._play(this._base("pec_message", "error.ogg"));
  },

  playComSound() {
    const n = Math.floor(Math.random() * 3) + 1;
    return this._play(this._base("pec_message", `Save_Sound_Communications_${n}.ogg`));
  },

  playComSoundThrottled(minIntervalMs = 200) {
    const now = performance?.now?.() ?? Date.now();
    if (now - this._lastComAt < minIntervalMs) return Promise.resolve();
    this._lastComAt = now;
    return this.playComSound();
  },

  async startReplySound() {
    if (!this.isEnabled()) return;
    this._continueReply = true;
    await this._playReplyOnce();
  },

  async _playReplyOnce() {
    if (!this._continueReply || !this.isEnabled()) return;
    if (this._replyAudio) {
      this._replyAudio.pause();
      this._replyAudio.currentTime = 0;
      this._replyAudio = null;
    }

    const n = Math.floor(Math.random() * 9) + 1;
    const src = this._base("reply", `Computer_Reply_${n}.ogg`);
    const volume = this.volume();

    try {
      if (typeof AudioHelper !== "undefined" && AudioHelper?.play) {
        await AudioHelper.play({ src, volume, autoplay: true, loop: false }, true);
        setTimeout(() => {
          if (this._continueReply) this._playReplyOnce();
        }, 900);
        return;
      }
    } catch {
      /* fall through */
    }

    const audio = new Audio(src);
    audio.volume = volume;
    audio.onended = () => {
      if (this._continueReply) this._playReplyOnce();
    };
    audio.onerror = () => {
      this._replyAudio = null;
    };
    this._replyAudio = audio;
    return audio.play();
  },

  stopReplySound() {
    this._continueReply = false;
    if (this._replyAudio) {
      this._replyAudio.pause();
      this._replyAudio.currentTime = 0;
      this._replyAudio = null;
    }
  }
};

/* -------------------------------------------- */
/*  Player Terminal Application                 */
/* -------------------------------------------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class MuthurPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;

  static DEFAULT_OPTIONS = {
    id: "muthur-terminal-player",
    tag: "div",
    classes: ["muthur-window"],
    window: {
      title: "MU/TH/UR 6000",
      icon: "fa-solid fa-terminal",
      resizable: true
    },
    position: { width: 640, height: 480 }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/muthur-terminal.hbs` }
  };

  constructor(options = {}) {
    super(options);
    this.readOnly = !!options.readOnly;
    this.watchUserId = options.watchUserId ?? null;
    this.watchUserName = options.watchUserName ?? "";
    if (this.readOnly && this.watchUserName) {
      this.options.window.title = localize("MUTHUR.Spectator.WindowTitle", { name: this.watchUserName });
    } else {
      this.options.window.title = localize("MUTHUR.WindowPlayerTitle");
    }
    if (this.readOnly && this.watchUserId) spectatorWatchUserId = this.watchUserId;
    this.waiting = !!options.waiting;
    this.booting = !!options.booting;
    this.commandHistory = [];
    this.historyIndex = -1;
    this.localPending = [];
    this._animatedIds = new Set();
    this._animatingIds = new Set();
    this._heardLineIds = new Set();
    this._bootSuppressed = false;
    this._bootEntry = null;
    this._bootAnimating = false;
    this._renderLocked = false;
    this._persistedMarked = false;
    this._animationQueue = Promise.resolve();
  }

  render(options) {
    if (this._renderLocked) return this;
    return super.render(options);
  }

  _getBootText() {
    return readMultilineSetting("bootText", "MUTHUR.SettingBootTextDefault");
  }

  _finalizeBoot() {
    if (this._bootEntry || this._bootSuppressed) return;
    this._bootEntry = {
      id: `boot-${foundry.utils.randomID()}`,
      type: "boot",
      text: this._getBootText(),
      timestamp: 0
    };
  }

  static open(options = {}) {
    if (game.user.isGM) return this._openInstance(options);
    if (options.skipSessionFlow) return this._openInstance({ waiting: false, booting: true });

    if (activeSession.userId && activeSession.userId !== game.user.id) {
      ui.notifications.warn(localize("MUTHUR.Session.ActiveWarning", { name: activeSession.userName }));
      return null;
    }

    if (this.current?.waiting) {
      this.current.render({ force: true });
      this.current.bringToFront();
      return this.current;
    }

    activeSession.userId = game.user.id;
    activeSession.userName = game.user.name;
    activeSession.spectatorIds = [];
    game.socket.emit(SOCKET, {
      action: "request-spectators",
      userId: game.user.id,
      userName: game.user.name
    });
    ui.notifications.info(localize("MUTHUR.Session.WaitingForGM"));
    return this._beginWaiting();
  }

  static _beginWaiting() {
    if (this.current?.readOnly) this.current.close({ animate: false });

    if (this.current && !this.current.readOnly) {
      this.current.waiting = true;
      this.current.booting = false;
      this.current._bootSequencePromise = null;
      this.current._bootSuppressed = true;
      this.current._bootEntry = null;
      this.current.localPending = [];
      this.current._animatedIds.clear();
      this.current._animatingIds.clear();
      this.current._persistedMarked = false;
      this.current._stopWaitingDots();
      MuthurSounds.stopReplySound();
      this.current.render({ force: true });
      this.current.bringToFront();
      return this.current;
    }

    return this._openInstance({ waiting: true });
  }

  authorize() {
    if (!this.waiting) return;
    this.waiting = false;
    this.booting = true;
    this._bootSuppressed = false;
    this._bootEntry = null;
    this._animatedIds.clear();
    this._animatingIds.clear();
    this._persistedMarked = false;
    this._bootSequencePromise = null;
    this._stopWaitingDots();
    this.render({ force: true });
  }

  _startWaitingDots() {
    const el = this.element?.querySelector(".muthur-waiting-dots");
    if (!el) return;
    this._stopWaitingDots();
    let dots = 1;
    el.textContent = ".";
    this._waitingDotsInterval = setInterval(() => {
      dots = (dots % 3) + 1;
      el.textContent = ".".repeat(dots);
    }, 500);
  }

  _stopWaitingDots() {
    if (!this._waitingDotsInterval) return;
    clearInterval(this._waitingDotsInterval);
    this._waitingDotsInterval = null;
  }

  static openSpectator(watchUserId, watchUserName) {
    spectatorWatchUserId = watchUserId;
    if (this.current?.readOnly && this.current.watchUserId === watchUserId) {
      this.current.render({ force: true });
      this.current.bringToFront();
      return this.current;
    }
    if (this.current) this.current.close({ animate: false });
    this.current = new MuthurPlayerApp({ readOnly: true, watchUserId, watchUserName, booting: true });
    this.current.render({ force: true });
    return this.current;
  }

  static _openInstance(options = {}) {
    const waiting = !!options.waiting;
    if (this.current && !this.current.readOnly && this.current.waiting === waiting) {
      this.current.render({ force: true });
      this.current.bringToFront();
      return this.current;
    }
    if (this.current) this.current.close({ animate: false });
    this.current = new MuthurPlayerApp(options);
    this.current.render({ force: true });
    return this.current;
  }

  _markPersistedOutputsSeen() {
    if (this._persistedMarked) return;
    this._persistedMarked = true;
    for (const entry of getTranscript().filter(isVisibleToMe)) {
      if (entry.type === "output") {
        this._animatedIds.add(entry.id ?? entry.tempId);
      }
    }
  }

  _enqueueAnimation(fn) {
    this._animationQueue = this._animationQueue.then(fn).catch((err) => {
      console.error(`${MODULE_ID} | animation error`, err);
    });
  }

  /** Combine persisted transcript entries visible to this user with local optimistic ones. */
  _buildLines() {
    const persisted = getTranscript().filter(isVisibleToMe);
    const persistedTempIds = new Set(persisted.map((e) => e.tempId).filter(Boolean));
    this.localPending = this.localPending.filter((p) => !persistedTempIds.has(p.tempId));

    const combined = [...persisted, ...this.localPending];
    if (this._bootEntry) combined.unshift(this._bootEntry);
    combined.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return combined;
  }

  async _prepareContext(_options) {
    if (this.waiting) {
      return {
        waiting: true,
        waitingTitle: localize("MUTHUR.WindowPlayerTitle"),
        waitingMessage: localize("MUTHUR.Session.WaitingForGM"),
        waitingDetail: localize("MUTHUR.Session.WaitingDetail")
      };
    }

    if (this.booting) {
      return {
        waiting: false,
        booting: true,
        bootLogoAlt: localize("MUTHUR.Boot.LogoAlt")
      };
    }

    this._markPersistedOutputsSeen();
    if (!isTypewriterEnabled()) this._finalizeBoot();

    const lines = this._buildLines().map((entry) => {
      const id = entry.id ?? entry.tempId;
      const animates = isTypewriterEnabled() && entry.type === "output";
      const needsAnimation = animates && !this._animatedIds.has(id) && !this._animatingIds.has(id);
      return {
        id,
        type: entry.type,
        text: entry.text,
        html: needsAnimation ? "" : formatEntryHtml(entry)
      };
    });
    this._lines = lines;
    return {
      waiting: false,
      booting: false,
      bootSlot: isTypewriterEnabled() && !this._bootEntry && !this._bootSuppressed,
      lines,
      readOnly: this.readOnly,
      prompt: resolveLocalizedText(game.settings.get(MODULE_ID, "prompt"), "MUTHUR.DefaultPrompt"),
      inputPlaceholder: localize("MUTHUR.InputPlaceholder")
    };
  }

  _onRender(_context, _options) {
    if (this.waiting) {
      this._startWaitingDots();
      return;
    }
    this._stopWaitingDots();

    if (this.booting) {
      void this._runFullBootSequence();
      return;
    }

    if (this.readOnly) {
      requestAnimationFrame(() => {
        if (!this.element?.isConnected) return;
        Promise.resolve(this._animateBootIfNeeded()).then(() => {
          if (!this.element?.isConnected) return;
          this._animateNewLines();
        });
      });
      return;
    }

    const input = this.element.querySelector(".muthur-input");
    if (input) {
      input.addEventListener("keydown", this._onKeyDown.bind(this));
      input.focus();
    }
    // Defer until ApplicationV2 has committed part HTML (avoids missing nodes / double-render races).
    requestAnimationFrame(() => {
      if (!this.element?.isConnected) return;
      Promise.resolve(this._animateBootIfNeeded()).then(() => {
        if (!this.element?.isConnected) return;
        this._animateNewLines();
        this._playNewLineSounds();
        this._scrollToBottom();
      });
    });
  }

  _runFullBootSequence() {
    if (!this.booting || this._bootSequencePromise) return this._bootSequencePromise;
    this._bootSequencePromise = this._executeFullBootSequence().finally(() => {
      this._bootSequencePromise = null;
    });
    return this._bootSequencePromise;
  }

  async _executeFullBootSequence() {
    if (!this.booting || !this.element?.isConnected) return;

    const screenEl = this.element.querySelector(".muthur-boot-screen");
    const logoEl = this.element.querySelector("[data-muthur-boot-logo]");
    const messagesEl = this.element.querySelector("[data-muthur-boot-messages]");
    if (!screenEl || !logoEl || !messagesEl) return;

    messagesEl.replaceChildren();
    this._renderLocked = true;

    const fast = !isTypewriterEnabled();
    const lineDelay = fast ? 200 : 800;
    const speed = Number(game.settings.get(MODULE_ID, "typeSpeed")) || 18;
    const isActive = () => this.booting && !!this.element?.isConnected;

    try {
      for (const key of BOOT_SEQUENCE_KEYS) {
        if (!isActive()) return;
        const msg = document.createElement("div");
        msg.className = "muthur-boot-line";
        messagesEl.appendChild(msg);
        await delay(lineDelay);
        if (!isActive()) return;
        const text = localize(key);
        if (fast) msg.textContent = text;
        else if (isScrambleEnabled()) await typewriteScramble(msg, text, speed, isActive);
        else await typewritePlain(msg, text, speed, isActive);
        MuthurSounds.playComSoundThrottled();
        if (Math.random() > 0.7) {
          msg.classList.add("muthur-boot-glitch");
          await delay(120);
          msg.classList.remove("muthur-boot-glitch");
        }
        this._scrollBootMessages();
      }

      await delay(fast ? 800 : 2500);
      if (!isActive()) return;

      screenEl.classList.add("muthur-boot-powerdown");
      await delay(700);
      if (!isActive()) return;

      this.booting = false;
      this._renderLocked = false;
      await this.render({ force: true });
    } catch (err) {
      console.error(`${MODULE_ID} | boot sequence error`, err);
      this.booting = false;
      this._renderLocked = false;
      await this.render({ force: true });
    }
  }

  _scrollBootMessages() {
    const content = this.element?.querySelector(".muthur-boot-content");
    if (content) content.scrollTop = content.scrollHeight;
  }

  _animateBootIfNeeded() {
    if (!isTypewriterEnabled() || this._bootEntry || this._bootSuppressed || this._bootAnimating) {
      return Promise.resolve();
    }
    const el = this.element.querySelector("[data-muthur-boot-slot]");
    if (!el) return Promise.resolve();

    this._bootAnimating = true;
    this._renderLocked = true;
    const speed = Number(game.settings.get(MODULE_ID, "typeSpeed")) || 18;
    const isActive = () => !!this.element?.isConnected;

    return new Promise((resolve) => {
      this._enqueueAnimation(async () => {
        try {
          await animateTerminalText(el, {
            text: this._getBootText(),
            type: "boot",
            speed,
            scrollFn: () => this._scrollToBottom(),
            isActive
          });
          this._finalizeBoot();
        } finally {
          this._bootAnimating = false;
          this._renderLocked = false;
          if (this._bootEntry) await this.render({ force: true });
          resolve();
        }
      });
    });
  }

  _playNewLineSounds() {
    for (const line of this._lines ?? []) {
      if (this._heardLineIds.has(line.id)) continue;
      this._heardLineIds.add(line.id);
      if (line.type === "system") MuthurSounds.playErrorSound();
    }
  }

  _animateNewLines() {
    if (!isTypewriterEnabled()) return;
    const speed = Number(game.settings.get(MODULE_ID, "typeSpeed")) || 18;
    const isActive = () => !!this.element?.isConnected;

    for (const line of this._lines ?? []) {
      if (line.type !== "output") continue;
      if (this._animatedIds.has(line.id) || this._animatingIds.has(line.id)) continue;
      const el = this.element.querySelector(`.muthur-line[data-id="${CSS.escape(String(line.id))}"]`);
      if (!el) continue;
      this._animatingIds.add(line.id);
      this._enqueueAnimation(async () => {
        try {
          await animateTerminalText(el, {
            text: line.text,
            type: line.type,
            speed,
            scrollFn: () => this._scrollToBottom(),
            isActive
          });
          this._animatedIds.add(line.id);
        } finally {
          this._animatingIds.delete(line.id);
        }
      });
    }
  }

  _scrollToBottom() {
    const log = this.element?.querySelector(".muthur-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  _onKeyDown(event) {
    const input = event.currentTarget;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      MuthurSounds.playTypeSound();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      MuthurSounds.playReturnSound();
      input.value = "";
      this.commandHistory.push(text);
      this.historyIndex = this.commandHistory.length;
      this._submitCommand(text);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (this.historyIndex > 0) {
        this.historyIndex--;
        input.value = this.commandHistory[this.historyIndex] ?? "";
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (this.historyIndex < this.commandHistory.length - 1) {
        this.historyIndex++;
        input.value = this.commandHistory[this.historyIndex] ?? "";
      } else {
        this.historyIndex = this.commandHistory.length;
        input.value = "";
      }
    }
  }

  _submitCommand(text) {
    if (this.readOnly) return;

    const lower = text.toLowerCase();

    // A couple of purely local, client-side conveniences.
    if (lower === "clear" || lower === "cls") {
      MuthurSounds.stopReplySound();
      this.localPending = [];
      this._animatedIds.clear();
      this._animatingIds.clear();
      this._bootEntry = null;
      this._bootSuppressed = true;
      this.render();
      return;
    }
    if (lower === "help") {
      const id = foundry.utils.randomID();
      MuthurSounds.playComSoundThrottled();
      this._heardLineIds.add(id);
      this.localPending.push({
        id,
        type: "system",
        text: localize("MUTHUR.Commands.help"),
        timestamp: Date.now(),
        local: true
      });
      this.render();
      return;
    }

    const tempId = foundry.utils.randomID();
    this.localPending.push({
      tempId,
      id: tempId,
      type: "input",
      text,
      authorId: game.user.id,
      authorName: game.user.name,
      timestamp: Date.now(),
      pending: true
    });
    this.render();

    game.socket.emit(SOCKET, {
      action: "command",
      tempId,
      userId: game.user.id,
      userName: game.user.name,
      text
    });
  }

  refresh() {
    this.render();
  }

  _onClose(options) {
    MuthurSounds.stopReplySound();
    this._stopWaitingDots();
    this.booting = false;
    this._bootSequencePromise = null;
    super._onClose(options);
    if (this.readOnly && spectatorWatchUserId === this.watchUserId) {
      spectatorWatchUserId = null;
    } else if (!game.user.isGM && activeSession.userId === game.user.id) {
      activeSession.userId = null;
      activeSession.userName = null;
      activeSession.spectatorIds = [];
      game.socket.emit(SOCKET, { action: "session-end", userId: game.user.id });
    }
    if (MuthurPlayerApp.current === this) MuthurPlayerApp.current = null;
  }
}

/* -------------------------------------------- */
/*  GM Console Application                       */
/* -------------------------------------------- */

class MuthurGMApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static current = null;

  static DEFAULT_OPTIONS = {
    id: "muthur-terminal-gm",
    tag: "div",
    classes: ["muthur-window"],
    window: {
      title: "MU/TH/UR Console (GM)",
      icon: "fa-solid fa-satellite-dish",
      resizable: true
    },
    position: { width: 560, height: 560 }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/muthur-gm.hbs` }
  };

  constructor(options = {}) {
    super(options);
    this.options.window.title = localize("MUTHUR.WindowGMTitle");
  }

  static open() {
    if (!game.user.isGM) return null;
    if (this.current) {
      this.current.render({ force: true });
      this.current.bringToFront();
    } else {
      this.current = new MuthurGMApp();
      this.current.render({ force: true });
    }
    return this.current;
  }

  async _prepareContext(_options) {
    const lines = getTranscript().map((entry) => ({
      id: entry.id,
      type: entry.type,
      html: formatEntryHtml(entry, { showAuthor: true })
    }));
    const users = game.users
      .filter((u) => !u.isGM)
      .map((u) => ({ id: u.id, name: u.name, active: u.active }));
    return {
      lines,
      users,
      targetTitle: localize("MUTHUR.GM.TargetTitle"),
      allTerminals: localize("MUTHUR.GM.AllTerminals"),
      offlineLabel: localize("MUTHUR.GM.Offline"),
      inputPlaceholder: localize("MUTHUR.GM.InputPlaceholder"),
      sendTitle: localize("MUTHUR.GM.Send"),
      forceOpenLabel: localize("MUTHUR.GM.ForceOpen"),
      systemAlertLabel: localize("MUTHUR.GM.SystemAlert"),
      clearLabel: localize("MUTHUR.GM.ClearTranscript")
    };
  }

  _bindHelpButton() {
    const header = this.element?.querySelector(".window-header");
    if (!header || header.querySelector(".muthur-gm-help-btn")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "header-control muthur-gm-help-btn";
    btn.textContent = "?";
    btn.dataset.tooltip = localize("MUTHUR.GM.HelpTooltip");
    btn.setAttribute("aria-label", localize("MUTHUR.GM.HelpTooltip"));
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._toggleHelpPanel();
    });

    const closeBtn = header.querySelector('[data-action="close"]');
    if (closeBtn?.parentElement) closeBtn.parentElement.insertBefore(btn, closeBtn);
    else header.appendChild(btn);
  }

  _buildHelpPanelHtml() {
    const playerCommands = escapeHtml(localize("MUTHUR.Commands.help")).replace(/\n/g, "<br>");
    const consoleHelp = escapeHtml(localize("MUTHUR.GM.HelpConsole")).replace(/\n/g, "<br>");
    return `
      <div class="muthur-gm-help-header">
        <strong>${escapeHtml(localize("MUTHUR.GM.HelpTitle"))}</strong>
        <button type="button" class="muthur-gm-help-close" title="${escapeHtml(localize("MUTHUR.GM.HelpClose"))}">&times;</button>
      </div>
      <div class="muthur-gm-help-body">
        <section>
          <h3>${escapeHtml(localize("MUTHUR.GM.HelpPlayerSection"))}</h3>
          <div class="muthur-gm-help-text">${playerCommands}</div>
        </section>
        <hr>
        <section>
          <h3>${escapeHtml(localize("MUTHUR.GM.HelpConsoleSection"))}</h3>
          <div class="muthur-gm-help-text">${consoleHelp}</div>
        </section>
      </div>
    `;
  }

  _positionHelpPanel(panel) {
    const rect = this.element.getBoundingClientRect();
    const width = 360;
    const gap = 10;
    let left = rect.left - width - gap;
    if (left < gap) left = rect.right + gap;
    panel.style.top = `${rect.top}px`;
    panel.style.left = `${left}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${rect.height}px`;
  }

  _toggleHelpPanel() {
    if (this._helpPanel?.isConnected) {
      this._helpPanel.remove();
      this._helpPanel = null;
      return;
    }

    const panel = document.createElement("aside");
    panel.className = "muthur-gm-help-panel";
    panel.innerHTML = this._buildHelpPanelHtml();
    panel.querySelector(".muthur-gm-help-close")?.addEventListener("click", () => {
      panel.remove();
      if (this._helpPanel === panel) this._helpPanel = null;
    });
    this._positionHelpPanel(panel);
    document.body.appendChild(panel);
    this._helpPanel = panel;
  }

  _closeHelpPanel() {
    this._helpPanel?.remove();
    this._helpPanel = null;
  }

  _onRender(_context, _options) {
    this._bindHelpButton();
    this._scrollToBottom();

    const sendBtn = this.element.querySelector(".muthur-gm-send");
    const input = this.element.querySelector(".muthur-gm-input");
    const send = () => this._sendReply();
    sendBtn?.addEventListener("click", send);
    input?.addEventListener("keydown", (event) => {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        MuthurSounds.playTypeSound();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        send();
      }
    });

    this.element.querySelector(".muthur-force-open")?.addEventListener("click", () => {
      game.socket.emit(SOCKET, { action: "force-open" });
      ui.notifications.info(localize("MUTHUR.GM.ForceOpenNotify"));
    });

    this.element.querySelector(".muthur-system-msg")?.addEventListener("click", () => {
      this._promptSystemMessage();
    });

    this.element.querySelector(".muthur-clear")?.addEventListener("click", () => {
      Dialog.confirm({
        title: localize("MUTHUR.GM.ClearTitle"),
        content: `<p>${escapeHtml(localize("MUTHUR.GM.ClearContent"))}</p>`,
        yes: () => clearTranscript(),
        defaultYes: false
      });
    });
  }

  async _sendReply() {
    const input = this.element.querySelector(".muthur-gm-input");
    const target = this.element.querySelector(".muthur-target");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    const scope = target.value === "all" ? "all" : [target.value];
    await pushTranscriptEntry({
      id: foundry.utils.randomID(),
      type: "output",
      text,
      authorId: "muthur",
      scope,
      timestamp: Date.now()
    });
    input.focus();
  }

  async _promptSystemMessage() {
    new Dialog({
      title: localize("MUTHUR.GM.SystemAlertTitle"),
      content: `<form><div class="form-group"><label>${escapeHtml(localize("MUTHUR.GM.SystemAlertLabel"))}</label>
        <input type="text" name="msg" style="width:100%" placeholder="${escapeHtml(localize("MUTHUR.GM.SystemAlertPlaceholder"))}"/></div></form>`,
      buttons: {
        send: {
          icon: '<i class="fa-solid fa-paper-plane"></i>',
          label: localize("MUTHUR.GM.Send"),
          callback: async (html) => {
            const text = html.find('[name="msg"]').val()?.trim();
            if (!text) return;
            await pushTranscriptEntry({
              id: foundry.utils.randomID(),
              type: "system",
              text,
              authorId: "muthur",
              scope: "all",
              timestamp: Date.now()
            });
          }
        }
      },
      default: "send"
    }).render(true);
  }

  _scrollToBottom() {
    const log = this.element?.querySelector(".muthur-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  refresh() {
    this.render();
  }

  _onClose(options) {
    this._closeHelpPanel();
    super._onClose(options);
    if (MuthurGMApp.current === this) MuthurGMApp.current = null;
  }
}

/* -------------------------------------------- */
/*  Spectator session (GM prompt)                */
/* -------------------------------------------- */

function emitSessionBegin(activeUserId, activeUserName, spectatorIds) {
  game.socket.emit(SOCKET, {
    action: "session-begin",
    activeUserId,
    activeUserName,
    spectatorIds
  });
}

function showSpectatorSelectionDialog(activeUserId, activeUserName) {
  if (!game.user.isGM) return;
  if (pendingSpectatorRequestId === activeUserId) return;
  pendingSpectatorRequestId = activeUserId;

  MuthurGMApp.open();

  const players = game.users.filter((u) => !u.isGM && u.active && u.id !== activeUserId);
  const checkboxes = players.length
    ? players
        .map(
          (p) =>
            `<label class="muthur-spectator-choice"><input type="checkbox" name="spectators" value="${p.id}"> ${escapeHtml(p.name)}</label>`
        )
        .join("")
    : `<p class="muthur-spectator-empty">${escapeHtml(localize("MUTHUR.Spectator.NoPlayers"))}</p>`;

  let resolved = false;
  const finish = (spectatorIds) => {
    if (resolved) return;
    resolved = true;
    pendingSpectatorRequestId = null;
    emitSessionBegin(activeUserId, activeUserName, spectatorIds);
  };

  new Dialog(
    {
      title: localize("MUTHUR.Spectator.Title"),
      content: `<p>${escapeHtml(localize("MUTHUR.Spectator.Intro", { name: activeUserName }))}</p><form class="muthur-spectator-form">${checkboxes}</form>`,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-check"></i>',
          label: localize("MUTHUR.Spectator.Confirm"),
          callback: (html) => {
            const ids = [];
            html.find('input[name="spectators"]:checked').each((_i, el) => ids.push(el.value));
            finish(ids);
          }
        },
        skip: {
          icon: '<i class="fas fa-forward"></i>',
          label: localize("MUTHUR.Spectator.Skip"),
          callback: () => finish([])
        }
      },
      default: "confirm",
      close: () => finish([])
    },
    { classes: ["muthur-spectator-dialog"], width: 420 }
  ).render(true);
}

function handleSessionBegin(data) {
  activeSession.userId = data.activeUserId;
  activeSession.userName = data.activeUserName;
  activeSession.spectatorIds = data.spectatorIds ?? [];

  if (game.user.isGM) return;

  if (game.user.id === data.activeUserId) {
    if (MuthurPlayerApp.current?.waiting) MuthurPlayerApp.current.authorize();
    else if (!MuthurPlayerApp.current) MuthurPlayerApp._openInstance({ waiting: false, booting: true });
    return;
  }

  if (data.spectatorIds?.includes(game.user.id)) {
    MuthurPlayerApp.openSpectator(data.activeUserId, data.activeUserName);
    ui.notifications.info(localize("MUTHUR.Spectator.OpenNotify", { name: data.activeUserName }));
  }
}

function handleSessionEnd(data) {
  if (activeSession.userId !== data.userId) return;
  activeSession.userId = null;
  activeSession.userName = null;
  activeSession.spectatorIds = [];
  if (spectatorWatchUserId === data.userId) MuthurPlayerApp.current?.close();
  if (game.user.id === data.userId && MuthurPlayerApp.current?.waiting) {
    MuthurPlayerApp.current.close({ animate: false });
  }
}

/* -------------------------------------------- */
/*  Socket handling                              */
/* -------------------------------------------- */

async function onSocketEvent(data) {
  if (!data?.action) return;

  if (data.action === "force-open") {
    if (!game.user.isGM) MuthurPlayerApp.open({ skipSessionFlow: true });
    return;
  }

  if (data.action === "request-spectators") {
    if (game.user.isGM) showSpectatorSelectionDialog(data.userId, data.userName);
    return;
  }

  if (data.action === "session-begin") {
    handleSessionBegin(data);
    return;
  }

  if (data.action === "session-end") {
    handleSessionEnd(data);
    return;
  }

  if (data.action === "command") {
    if (!game.user.isGM) return;

    await pushTranscriptEntry({
      id: foundry.utils.randomID(),
      tempId: data.tempId,
      type: "input",
      text: data.text,
      authorId: data.userId,
      authorName: data.userName,
      scope: [data.userId],
      timestamp: Date.now()
    });

    if (!game.settings.get(MODULE_ID, "enableScriptedResponses")) return;

    const response = resolveScriptedCommand(data.text);
    if (!response) return;

    await pushTranscriptEntry({
      id: foundry.utils.randomID(),
      type: response.type ?? "output",
      text: response.text,
      authorId: "muthur",
      scope: [data.userId],
      timestamp: Date.now(),
      scripted: true
    });
  }
}

/* -------------------------------------------- */
/*  Init / Ready hooks                           */
/* -------------------------------------------- */

Hooks.once("init", () => {
  bindSettingsConfigTextareas();

  game.settings.register(MODULE_ID, "transcript", {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "typeSpeed", {
    name: "MUTHUR.SettingTypeSpeedName",
    hint: "MUTHUR.SettingTypeSpeedHint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 5, max: 80, step: 1 },
    default: 18
  });

  game.settings.register(MODULE_ID, "enableTypewriter", {
    name: "MUTHUR.SettingEnableTypewriterName",
    hint: "MUTHUR.SettingEnableTypewriterHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "enableScrambleTypewriter", {
    name: "MUTHUR.SettingEnableScrambleName",
    hint: "MUTHUR.SettingEnableScrambleHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "enableScanline", {
    name: "MUTHUR.SettingEnableScanlineName",
    hint: "MUTHUR.SettingEnableScanlineHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "scanlineSize", {
    name: "MUTHUR.SettingScanlineSizeName",
    hint: "MUTHUR.SettingScanlineSizeHint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 10, max: 100, step: 5 },
    default: 30
  });

  game.settings.register(MODULE_ID, "enableTypingSounds", {
    name: "MUTHUR.SettingTypingSoundsName",
    hint: "MUTHUR.SettingTypingSoundsHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "typingSoundVolume", {
    name: "MUTHUR.SettingTypingSoundVolumeName",
    hint: "MUTHUR.SettingTypingSoundVolumeHint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.1 },
    default: 0.2
  });

  game.settings.register(MODULE_ID, "enableScriptedResponses", {
    name: "MUTHUR.SettingScriptedResponsesName",
    hint: "MUTHUR.SettingScriptedResponsesHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "statusPreset", {
    name: "MUTHUR.SettingStatusPresetName",
    hint: "MUTHUR.SettingStatusPresetHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      normal: "MUTHUR.SettingStatusPreset.normal",
      anomalyDetected: "MUTHUR.SettingStatusPreset.anomalyDetected",
      degradedPerformance: "MUTHUR.SettingStatusPreset.degradedPerformance",
      fireDetected: "MUTHUR.SettingStatusPreset.fireDetected",
      quarantine: "MUTHUR.SettingStatusPreset.quarantine",
      lockdown: "MUTHUR.SettingStatusPreset.lockdown",
      intrusion: "MUTHUR.SettingStatusPreset.intrusion",
      networkIssue: "MUTHUR.SettingStatusPreset.networkIssue",
      custom: "MUTHUR.SettingStatusPreset.custom"
    },
    default: "normal"
  });

  game.muthur = {
    open: () => MuthurPlayerApp.open(),
    openPlayer: () => MuthurPlayerApp.open(),
    openGM: () => MuthurGMApp.open(),
    forceOpenAll: () => game.socket.emit(SOCKET, { action: "force-open" }),
    clearTranscript: () => clearTranscript()
  };
});

Hooks.once("i18nInit", () => {
  registerMultilineWorldSetting(
    "bootText",
    "MUTHUR.SettingBootTextName",
    "MUTHUR.SettingBootTextHint",
    "MUTHUR.SettingBootTextDefault"
  );

  registerSingleLineWorldSetting(
    "prompt",
    "MUTHUR.SettingPromptName",
    "MUTHUR.SettingPromptHint",
    "MUTHUR.DefaultPrompt"
  );

  registerMultilineWorldSetting(
    "statusCustomText",
    "MUTHUR.SettingStatusCustomName",
    "MUTHUR.SettingStatusCustomHint",
    "MUTHUR.SettingStatusCustomDefault"
  );
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocketEvent);
  migrateLocalizedSettingDefaults();
});

const LOCALIZED_SETTING_DEFAULTS = [
  { key: "bootText", i18nKey: "MUTHUR.SettingBootTextDefault", multiline: true },
  { key: "prompt", i18nKey: "MUTHUR.DefaultPrompt", multiline: false },
  { key: "statusCustomText", i18nKey: "MUTHUR.SettingStatusCustomDefault", multiline: true }
];

/** Fill world settings that were left empty, stored as unresolved i18n keys, or flattened to one line. */
async function migrateLocalizedSettingDefaults() {
  if (!game.user.isGM) return;

  for (const { key, i18nKey, multiline } of LOCALIZED_SETTING_DEFAULTS) {
    const value = game.settings.get(MODULE_ID, key);
    const localized = localizedDefault(i18nKey);

    if (value === "" || value === i18nKey) {
      await game.settings.set(MODULE_ID, key, localized);
      continue;
    }

    if (multiline && localized.includes("\n") && !String(value).includes("\n")) {
      await game.settings.set(MODULE_ID, key, localized);
    }
  }
}

Hooks.on("updateSetting", (setting) => {
  const key = setting?.key ?? setting;
  if (key !== `${MODULE_ID}.transcript`) return;
  MuthurPlayerApp.current?.refresh();
  MuthurGMApp.current?.refresh();
});

Hooks.on("getSceneControlButtons", (controls) => {
  const playerTool = {
    name: "muthur",
    title: "MUTHUR.OpenTerminal",
    icon: "fa-solid fa-terminal",
    button: true,
    onClick: () => game.muthur.open(),
    onChange: () => game.muthur.open()
  };
  const gmTool = {
    name: "muthur-console",
    title: "MUTHUR.OpenConsole",
    icon: "fa-solid fa-satellite-dish",
    button: true,
    visible: game.user.isGM,
    onClick: () => game.muthur.openGM(),
    onChange: () => game.muthur.openGM()
  };

  if (Array.isArray(controls)) {
    // Legacy (pre-v13) array-of-groups format.
    const tokenGroup = controls.find((c) => c.name === "token");
    if (tokenGroup) {
      tokenGroup.tools.push(playerTool);
      if (game.user.isGM) tokenGroup.tools.push(gmTool);
    }
  } else if (controls?.tokens?.tools) {
    // v13+ object format.
    controls.tokens.tools.muthur = playerTool;
    if (game.user.isGM) controls.tokens.tools["muthur-console"] = gmTool;
  }
});
