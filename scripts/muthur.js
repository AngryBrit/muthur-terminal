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
  if (entry.scope === "all") return true;
  if (Array.isArray(entry.scope) && entry.scope.includes(game.user.id)) return true;
  if (entry.authorId === game.user.id) return true;
  return false;
}

function formatEntryHtml(entry, { showAuthor = false } = {}) {
  let prefix = "";
  if (entry.type === "input") {
    const who = showAuthor && entry.authorName ? `<span class="muthur-author">[${escapeHtml(entry.authorName)}]</span> ` : "";
    prefix = `<span class="muthur-caret">&gt;</span> ${who}`;
  } else if (entry.type === "output") {
    prefix = `<span class="muthur-tag">MU/TH/UR:</span> `;
  } else if (entry.type === "system") {
    prefix = `<span class="muthur-tag muthur-sys">SYSTEM:</span> `;
  }
  const body = escapeHtml(entry.text ?? "").replace(/\n/g, "<br>");
  return prefix + body;
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
    this.commandHistory = [];
    this.historyIndex = -1;
    this.localPending = [];
    this._animatedIds = new Set();
    this._heardLineIds = new Set();
    this._bootTyped = false;
  }

  static open() {
    if (this.current) {
      this.current.render({ force: true });
      this.current.bringToFront();
    } else {
      this.current = new MuthurPlayerApp();
      this.current.render({ force: true });
    }
    return this.current;
  }

  /** Combine persisted transcript entries visible to this user with local optimistic ones. */
  _buildLines() {
    const persisted = getTranscript().filter(isVisibleToMe);
    const persistedTempIds = new Set(persisted.map((e) => e.tempId).filter(Boolean));
    this.localPending = this.localPending.filter((p) => !persistedTempIds.has(p.tempId));

    if (!this._bootTyped) {
      this._bootTyped = true;
      const bootText = game.settings.get(MODULE_ID, "bootText");
      this.localPending.unshift({
        id: "boot-" + this.id,
        type: "boot",
        text: bootText,
        timestamp: 0,
        local: true
      });
    }

    const combined = [...persisted, ...this.localPending];
    combined.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return combined;
  }

  async _prepareContext(_options) {
    const lines = this._buildLines().map((entry) => {
      const id = entry.id ?? entry.tempId;
      const needsAnimation = entry.type === "output" && !this._animatedIds.has(id);
      return {
        id,
        type: entry.type,
        text: entry.text,
        html: needsAnimation ? "" : formatEntryHtml(entry)
      };
    });
    this._lines = lines;
    return {
      lines,
      prompt: game.settings.get(MODULE_ID, "prompt") || "INTERFACE 2037>"
    };
  }

  _onRender(_context, _options) {
    const input = this.element.querySelector(".muthur-input");
    if (input) {
      input.addEventListener("keydown", this._onKeyDown.bind(this));
      input.focus();
    }
    this._animateNewOutputLines();
    this._playNewLineSounds();
    this._scrollToBottom();
  }

  _playNewLineSounds() {
    for (const line of this._lines ?? []) {
      if (this._heardLineIds.has(line.id)) continue;
      this._heardLineIds.add(line.id);
      if (line.type === "system") MuthurSounds.playErrorSound();
      else if (line.type === "boot") MuthurSounds.playComSoundThrottled();
    }
  }

  _animateNewOutputLines() {
    const speed = Number(game.settings.get(MODULE_ID, "typeSpeed")) || 18;
    for (const line of this._lines ?? []) {
      if (line.type !== "output") continue;
      if (this._animatedIds.has(line.id)) continue;
      const el = this.element.querySelector(`.muthur-line[data-id="${CSS.escape(String(line.id))}"]`);
      if (!el) continue;
      this._animatedIds.add(line.id);
      el.innerHTML = `<span class="muthur-tag">MU/TH/UR:</span> `;
      this._typewrite(el, line.text ?? "", speed);
    }
  }

  _typewrite(el, text, speed) {
    MuthurSounds.startReplySound();
    let i = 0;
    const step = () => {
      if (!this.element?.isConnected) {
        MuthurSounds.stopReplySound();
        return;
      }
      if (i >= text.length) {
        MuthurSounds.stopReplySound();
        this._scrollToBottom();
        return;
      }
      const ch = text[i];
      if (ch === " ") MuthurSounds.playComSoundThrottled();
      if (ch === "\n") el.appendChild(document.createElement("br"));
      else el.appendChild(document.createTextNode(ch));
      i++;
      this._scrollToBottom();
      setTimeout(step, speed);
    };
    step();
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
    const lower = text.toLowerCase();

    // A couple of purely local, client-side conveniences.
    if (lower === "clear" || lower === "cls") {
      MuthurSounds.stopReplySound();
      this.localPending = [];
      this._animatedIds.clear();
      this._bootTyped = true; // don't re-show boot text
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
        text: "Local commands: HELP, CLEAR. Anything else is relayed to MU/TH/UR for a response.",
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
    super._onClose(options);
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
    return { lines, users };
  }

  _onRender(_context, _options) {
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
      ui.notifications.info("Forced open MU/TH/UR terminals on all connected clients.");
    });

    this.element.querySelector(".muthur-system-msg")?.addEventListener("click", () => {
      this._promptSystemMessage();
    });

    this.element.querySelector(".muthur-clear")?.addEventListener("click", () => {
      Dialog.confirm({
        title: "Clear MU/TH/UR Transcript",
        content: "<p>This will erase the terminal transcript for everyone. Continue?</p>",
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
      title: "Send System Alert",
      content: `<form><div class="form-group"><label>Message</label>
        <input type="text" name="msg" style="width:100%" placeholder="e.g. WARNING: HULL BREACH DETECTED"/></div></form>`,
      buttons: {
        send: {
          icon: '<i class="fa-solid fa-paper-plane"></i>',
          label: "Send",
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
    super._onClose(options);
    if (MuthurGMApp.current === this) MuthurGMApp.current = null;
  }
}

/* -------------------------------------------- */
/*  Socket handling                              */
/* -------------------------------------------- */

function onSocketEvent(data) {
  if (!data?.action) return;

  if (data.action === "force-open") {
    if (!game.user.isGM) MuthurPlayerApp.open();
    return;
  }

  if (data.action === "command") {
    // Only the GM persists incoming queries into the shared transcript.
    if (!game.user.isGM) return;
    pushTranscriptEntry({
      id: foundry.utils.randomID(),
      tempId: data.tempId,
      type: "input",
      text: data.text,
      authorId: data.userId,
      authorName: data.userName,
      scope: [data.userId],
      timestamp: Date.now()
    });
  }
}

/* -------------------------------------------- */
/*  Init / Ready hooks                           */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "transcript", {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "bootText", {
    name: "MUTHUR.SettingBootTextName",
    hint: "MUTHUR.SettingBootTextHint",
    scope: "world",
    config: true,
    type: String,
    default:
      "MU/TH/UR 6000 - INTERFACE 2037 v2.20\nWEYLAND-YUTANI CORP. ALL RIGHTS RESERVED.\nTYPE 'HELP' FOR AVAILABLE COMMANDS."
  });

  game.settings.register(MODULE_ID, "prompt", {
    name: "MUTHUR.SettingPromptName",
    hint: "MUTHUR.SettingPromptHint",
    scope: "world",
    config: true,
    type: String,
    default: "INTERFACE 2037>"
  });

  game.settings.register(MODULE_ID, "typeSpeed", {
    name: "MUTHUR.SettingTypeSpeedName",
    hint: "MUTHUR.SettingTypeSpeedHint",
    scope: "client",
    config: true,
    type: Number,
    default: 18
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

  game.muthur = {
    open: () => MuthurPlayerApp.open(),
    openPlayer: () => MuthurPlayerApp.open(),
    openGM: () => MuthurGMApp.open(),
    forceOpenAll: () => game.socket.emit(SOCKET, { action: "force-open" }),
    clearTranscript: () => clearTranscript()
  };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocketEvent);
});

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
