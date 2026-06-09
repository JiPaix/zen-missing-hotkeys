// ==UserScript==
// @name         Zen's Missing Hotkeys
// @include      chrome://browser/content/browser.xhtml
// @include      about:preferences*
// @include      about:settings*
// ==/UserScript==

(function () {
  "use strict";

  const PREF_PREFIX = "mod.zen-missing-hotkeys.";
  const MODIFIERS = ["ctrl", "control", "shift", "alt", "meta", "super", "win"];
  const PURE_MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"];
  const IGNORED_KEYS = [...PURE_MODIFIER_KEYS, "Dead", "Process", "Unidentified"];
  const DEBUG = false;

  // Each action maps to a pref (PREF_PREFIX + id), a settings field, and a
  // run() performing the tab operation. Shortcuts are unbound by default —
  // every action stays inactive until the user records one in settings.
  const ACTIONS = [
    {
      id: "close-tabs-below",
      label: "Close tabs below",
      run() {
        const cur = gBrowser.selectedTab;
        const all = Array.from(gBrowser.tabs);
        const idx = all.indexOf(cur);
        all
          .slice(idx + 1)
          .filter((t) => !t.hidden && !t.pinned)
          .forEach((t) => gBrowser.removeTab(t));
      },
    },
    {
      id: "close-other-tabs",
      label: "Close other tabs",
      run() {
        const cur = gBrowser.selectedTab;
        Array.from(gBrowser.tabs)
          .filter((t) => t !== cur && !t.hidden && !t.pinned)
          .forEach((t) => gBrowser.removeTab(t));
      },
    },
  ];

  const prefOf = (action) => PREF_PREFIX + action.id;

  // ---------- shortcut parsing / formatting ----------

  function parseShortcut(str) {
    const parts = (str || "").split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const keyParts = parts.filter((p) => !MODIFIERS.includes(p));
    const key = keyParts.length ? keyParts[keyParts.length - 1] : "";
    return {
      ctrl: parts.includes("ctrl") || parts.includes("control"),
      shift: parts.includes("shift"),
      alt: parts.includes("alt"),
      meta: parts.includes("meta") || parts.includes("super") || parts.includes("win"),
      key: key.length === 1 ? key.toUpperCase() : key,
    };
  }

  function shortcutFromEvent(e) {
    if (IGNORED_KEYS.includes(e.key)) return null; // waiting for a real key
    return {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
      key: e.key.length === 1 ? e.key.toUpperCase() : e.key,
    };
  }

  function heldModifiers(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Super");
    return parts.join("+");
  }

  function formatShortcut(s) {
    const parts = [];
    if (s.ctrl) parts.push("Ctrl");
    if (s.alt) parts.push("Alt");
    if (s.shift) parts.push("Shift");
    if (s.meta) parts.push("Super");
    if (s.key) parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
    return parts.join("+");
  }

  // A usable shortcut needs a key plus at least one "hard" modifier.
  function isComplete(s) {
    return !!s.key && (s.ctrl || s.alt || s.meta);
  }

  function sameShortcut(a, b) {
    return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta && a.key === b.key;
  }

  function getStored(pref) {
    try {
      return parseShortcut(Services.prefs.getStringPref(pref, ""));
    } catch (_) {
      return parseShortcut("");
    }
  }

  function eventMatches(e, s) {
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return (
      e.ctrlKey === s.ctrl &&
      e.shiftKey === s.shift &&
      e.altKey === s.alt &&
      e.metaKey === s.meta &&
      key === s.key
    );
  }

  // ---------- conflict detection ----------

  // Scans the live browser keyset (includes Zen's own shortcuts, registered as
  // <key> elements). Returns null if free, else a name ("" when unlabeled).
  function findBrowserConflict(s) {
    if (!isComplete(s)) return null;
    try {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const doc = win && win.document;
      if (!doc) return null;
      for (const el of doc.querySelectorAll("key")) {
        const elKey = el.getAttribute("key") || "";
        if (!elKey || elKey.toUpperCase() !== s.key.toUpperCase()) continue;
        const mods = (el.getAttribute("modifiers") || "")
          .toLowerCase()
          .split(/[\s,]+/)
          .filter(Boolean);
        const elCtrl = mods.some((m) => m === "control" || m === "accel");
        if (
          elCtrl === s.ctrl &&
          mods.includes("shift") === s.shift &&
          mods.includes("alt") === s.alt &&
          mods.includes("meta") === s.meta
        ) {
          let label = el.getAttribute("label");
          if (!label) {
            const refId = el.getAttribute("command") || el.getAttribute("observes") || "";
            const ref = refId ? doc.getElementById(refId) : null;
            label = (ref && ref.getAttribute("label")) || "";
          }
          return label;
        }
      }
    } catch (e) {
      if (DEBUG) console.warn("[zen-missing-hotkeys] conflict scan failed:", e);
    }
    return null;
  }

  // Returns the label of another of this mod's actions bound to the same combo.
  function findInternalConflict(s, exceptPref) {
    for (const a of ACTIONS) {
      if (prefOf(a) === exceptPref) continue;
      const other = getStored(prefOf(a));
      if (isComplete(other) && sameShortcut(other, s)) return a.label;
    }
    return null;
  }

  // ---------- browser window: run the actions ----------

  function initBrowser() {
    if (window.__zmhAction) return;
    window.__zmhAction = true;

    document.addEventListener(
      "keydown",
      (e) => {
        for (const action of ACTIONS) {
          const s = getStored(prefOf(action));
          if (isComplete(s) && eventMatches(e, s)) {
            e.preventDefault();
            e.stopPropagation();
            action.run();
            return;
          }
        }
      },
      true
    );

    if (DEBUG) console.log("[zen-missing-hotkeys] actions ready in browser window");
  }

  // ---------- settings page: press-to-record fields + live conflict ----------

  const COLORS = { warn: "#e67e22", ok: "#2ecc71", info: "var(--text-color-deemphasized, #9e9ea0)" };

  function wireField(action) {
    const rowId = prefOf(action).replace(/\./g, "-"); // e.g. mod-zen-missing-hotkeys-close-tabs-below
    const row = document.getElementById(rowId);
    if (!row || row.__zmhWired) return;
    const input = row.querySelector("input");
    if (!input) return;
    row.__zmhWired = true;

    input.readOnly = true; // capture key presses instead of free typing
    input.placeholder = "Click, then press a shortcut";
    input.style.cursor = "pointer";

    const msg = document.createXULElement("description");
    msg.id = rowId + "-msg";
    msg.style.cssText = "margin:2px 0 6px;font-size:12px;";
    msg.hidden = true;
    row.after(msg);

    const setMsg = (text, kind) => {
      if (!text) {
        msg.hidden = true;
        return;
      }
      msg.textContent = text;
      msg.style.color = COLORS[kind] || COLORS.info;
      msg.hidden = false;
    };

    // Only a complete combo updates this or is persisted; live key feedback is
    // cosmetic and wiped on blur.
    let committed = input.value;

    const save = (value) => {
      committed = value;
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true })); // let Sine persist
    };

    // Feedback right after recording a complete combo.
    const reportRecorded = (s) => {
      const internal = findInternalConflict(s, prefOf(action));
      if (internal) return setMsg(`⚠ Already assigned to “${internal}” in this mod.`, "warn");
      const browser = findBrowserConflict(s);
      if (browser !== null) {
        return setMsg(
          browser ? `⚠ Already used by “${browser}”. Pick another combination.` : "⚠ Already used, pick another combination.",
          "warn"
        );
      }
      setMsg("✓ Saved", "ok");
    };

    // Validate the stored value while idle (no recording prompt).
    const refresh = () => {
      const s = parseShortcut(committed);
      if (!isComplete(s)) {
        setMsg("Not set", "info");
        return;
      }
      const internal = findInternalConflict(s, prefOf(action));
      if (internal) return setMsg(`⚠ Also assigned to “${internal}” in this mod.`, "warn");
      const browser = findBrowserConflict(s);
      if (browser !== null) {
        setMsg(browser ? `⚠ Also used by “${browser}”.` : "⚠ Also used by another shortcut.", "warn");
      } else {
        setMsg("Del to clear", "info"); // persistent indicator when a hotkey is set
      }
    };

    input.addEventListener("focus", () =>
      setMsg(committed ? "Recording… press a combination, or Del to clear" : "Recording… press your combination", "info")
    );
    input.addEventListener("blur", () => {
      input.value = committed; // discard half-recorded display
      refresh();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") return; // allow focus move
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        input.blur();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        save("");
        setMsg("Cleared — not set", "info");
        return;
      }

      const s = shortcutFromEvent(e);
      if (!s) {
        const held = heldModifiers(e);
        input.value = held ? held + "+…" : "…";
        setMsg("Recording… press a key", "info");
        return;
      }
      if (!isComplete(s)) {
        input.value = formatShortcut(s);
        setMsg("⚠ Use Ctrl, Alt or Super together with a key.", "warn");
        return;
      }

      save(formatShortcut(s));
      reportRecorded(s);
    });

    refresh();
    if (DEBUG) console.log("[zen-missing-hotkeys] wired field:", action.id);
  }

  function initSettings() {
    if (window.__zmhSettings) return;
    window.__zmhSettings = true;

    const wireAll = () => ACTIONS.forEach(wireField);
    wireAll();
    const obs = new MutationObserver(wireAll);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("unload", () => obs.disconnect(), { once: true });
  }

  // ---------- dispatch by context ----------

  const href = (document.location && document.location.href) || "";
  if (DEBUG) console.log("[zen-missing-hotkeys] injected into", href);
  const SETTINGS_PREFIXES = ["about:preferences", "about:settings"]; // Zen exposes both
  if (SETTINGS_PREFIXES.some((p) => href.startsWith(p))) {
    initSettings();
  } else {
    initBrowser();
  }
})();
