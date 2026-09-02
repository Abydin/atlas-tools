// _ax.js -- Accessibility (AX) tree engine, invoked by osascript -l JavaScript.
// Not meant to be called directly; the `desktop` python executable in this
// same directory shells out to this file per subcommand. Kept as a separate
// file (rather than an inline python string) so it stays readable and diffable
// on its own.
//
// Usage (internal): osascript -l JavaScript _ax.js <command> <jsonArgsString>
// Commands: list-apps | windows | find | activate
// Always prints exactly one line of JSON to stdout.

function run(argv) {
  var command = argv[0];
  var args = {};
  try { args = JSON.parse(argv[1] || "{}"); } catch (e) { /* default {} */ }

  ObjC.import("AppKit");
  var SystemEvents = Application("System Events");
  SystemEvents.includeStandardAdditions = true;

  function safeCall(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function frontmostAppName() {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (var i = 0; i < apps.count; i++) {
      var a = apps.objectAtIndex(i);
      if (a.isActive) return ObjC.unwrap(a.localizedName);
    }
    return null;
  }

  function listApps() {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    var out = [];
    for (var i = 0; i < apps.count; i++) {
      var a = apps.objectAtIndex(i);
      // activationPolicy 0 == NSApplicationActivationPolicyRegular (has a Dock icon / real GUI app)
      // NOTE: use == not === here -- activationPolicy comes back as a JXA-wrapped
      // number, and strict equality against the primitive 0 silently fails, which
      // is why this list was returning empty at first.
      if (a.activationPolicy == 0) {
        out.push({
          name: ObjC.unwrap(a.localizedName),
          bundleId: a.bundleIdentifier ? ObjC.unwrap(a.bundleIdentifier) : "",
          active: !!a.isActive,
          pid: a.processIdentifier
        });
      }
    }
    return out;
  }

  function getWindows(appName) {
    var name = appName || frontmostAppName();
    if (!name) return { error: "no frontmost app detected" };
    var proc;
    try {
      proc = SystemEvents.processes[name];
      proc.name();
    } catch (e) {
      return { error: "process not found: " + name };
    }
    var wins = [];
    try {
      var windows = proc.windows();
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var pos = safeCall(function () { return w.position(); }, null);
        var size = safeCall(function () { return w.size(); }, null);
        // AXFullScreen, read straight off the raw AX attribute (not a
        // scripting-dictionary property, System Events exposes it via
        // .attributes only). null when it can't be read rather than a
        // guessed false, so a caller can tell "not fullscreen" apart from
        // "couldn't tell" -- see get_top_chrome/get_left_chrome in desktop,
        // which treat null as "skip this check", same as displayIndex/
        // backingScale already do.
        var fullScreen = safeCall(function () {
          return !!w.attributes["AXFullScreen"].value();
        }, null);
        wins.push({
          title: safeCall(function () { return w.name(); }, ""),
          x: pos ? Math.round(pos[0]) : null,
          y: pos ? Math.round(pos[1]) : null,
          w: size ? Math.round(size[0]) : null,
          h: size ? Math.round(size[1]) : null,
          fullScreen: fullScreen,
          index: i
        });
      }
    } catch (e) {
      return { error: "windows() failed for " + name + ": " + e };
    }
    return { app: name, windows: wins };
  }

  // generic-role -> AX role names. "any" walks everything interactive.
  var roleAliases = {
    "button": ["AXButton", "AXMenuButton"],
    "textfield": ["AXTextField", "AXTextArea"],
    "checkbox": ["AXCheckBox"],
    "radiobutton": ["AXRadioButton"],
    "popupbutton": ["AXPopUpButton"],
    "combobox": ["AXComboBox"],
    "menuitem": ["AXMenuItem", "AXMenuBarItem"],
    "link": ["AXLink"],
    "statictext": ["AXStaticText"],
    "tab": ["AXTabButton", "AXRadioButton"],
    "row": ["AXRow"],
    "cell": ["AXCell"],
    "slider": ["AXSlider"],
    "any": ["AXButton", "AXMenuButton", "AXTextField", "AXTextArea", "AXCheckBox",
            "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXMenuItem",
            "AXMenuBarItem", "AXLink", "AXStaticText", "AXTabButton", "AXRow",
            "AXCell", "AXSlider"]
  };

  function findElements(opts) {
    var appName = opts.app || frontmostAppName();
    if (!appName) return { error: "no frontmost app detected" };
    var role = (opts.role || "any").toLowerCase();
    var wantRoles = roleAliases[role];
    if (!wantRoles) {
      return { error: "unknown role '" + opts.role + "'. Known: " + Object.keys(roleAliases).join(", ") };
    }
    var wantRoleSet = {};
    for (var r = 0; r < wantRoles.length; r++) wantRoleSet[wantRoles[r]] = true;

    var namePartial = opts.name ? String(opts.name).toLowerCase() : null;
    var limit = opts.limit || 50;
    var windowIndex = (typeof opts.windowIndex === "number") ? opts.windowIndex : 0;

    var proc;
    try {
      proc = SystemEvents.processes[appName];
      proc.name();
    } catch (e) {
      return { error: "process not found: " + appName };
    }

    var results = [];
    var count = { n: 0 };

    function elName(el) {
      return safeCall(function () {
        var n = el.name();
        return (n === null || n === undefined) ? "" : String(n);
      }, "");
    }
    function elValue(el) {
      return safeCall(function () {
        var v = el.value();
        if (v === null || v === undefined) return "";
        return String(v);
      }, "");
    }
    function elRole(el) {
      return safeCall(function () { return String(el.role()); }, "unknown");
    }
    function elPos(el) {
      return safeCall(function () {
        var p = el.position();
        return { x: Math.round(p[0]), y: Math.round(p[1]) };
      }, null);
    }
    function elSize(el) {
      return safeCall(function () {
        var s = el.size();
        return { w: Math.round(s[0]), h: Math.round(s[1]) };
      }, null);
    }

    function walk(el, depth) {
      if (count.n >= limit) return;
      if (depth > 14) return;

      var role = elRole(el);
      if (wantRoleSet[role]) {
        var nm = elName(el);
        var matchesName = !namePartial || nm.toLowerCase().indexOf(namePartial) !== -1;
        if (matchesName) {
          var pos = elPos(el);
          var size = elSize(el);
          if (pos && size && size.w > 0 && size.h > 0) {
            results.push({
              role: role, name: nm, value: elValue(el),
              x: pos.x, y: pos.y, w: size.w, h: size.h,
              cx: Math.round(pos.x + size.w / 2), cy: Math.round(pos.y + size.h / 2)
            });
            count.n++;
          }
        }
      }
      var children;
      try { children = el.uiElements(); } catch (e) { return; }
      for (var i = 0; i < children.length && count.n < limit; i++) {
        try { walk(children[i], depth + 1); } catch (e) { /* skip broken node */ }
      }
    }

    try {
      var windows = proc.windows();
      if (windows.length === 0) return { error: "no windows for " + appName };
      var idx = windowIndex < windows.length ? windowIndex : 0;
      walk(windows[idx], 0);
    } catch (e) {
      return { error: "walk failed: " + e };
    }

    return { app: appName, matches: results };
  }

  // Press the Nth match's own default AX action (System Events' "click"
  // command on a UI element reference performs AXPress without moving the
  // mouse). Preferred over a coordinate click when available: immune to the
  // element being scrolled/occluded/moved since it's addressed directly,
  // not by a snapshotted x/y. Walks the tree itself (rather than reusing
  // findElements) because it needs to keep a live reference to the actual
  // element to call .click() on, findElements only returns plain data.
  function pressByQuery(opts) {
    var appName = opts.app || frontmostAppName();
    if (!appName) return { error: "no frontmost app detected" };
    var role = (opts.role || "any").toLowerCase();
    var wantRoles = roleAliases[role];
    if (!wantRoles) {
      return { error: "unknown role '" + opts.role + "'. Known: " + Object.keys(roleAliases).join(", ") };
    }
    var wantRoleSet = {};
    for (var r = 0; r < wantRoles.length; r++) wantRoleSet[wantRoles[r]] = true;

    var namePartial = opts.name ? String(opts.name).toLowerCase() : null;
    var targetIndex = opts.index || 0;

    var proc;
    try {
      proc = SystemEvents.processes[appName];
      proc.name();
    } catch (e) {
      return { error: "process not found: " + appName };
    }

    var matchCount = { n: -1 };
    var pressedInfo = null;
    var pressOk = null;
    var pressErr = null;

    function elName(el) {
      return safeCall(function () {
        var n = el.name();
        return (n === null || n === undefined) ? "" : String(n);
      }, "");
    }
    function elRole(el) {
      return safeCall(function () { return String(el.role()); }, "unknown");
    }
    function elPos(el) {
      return safeCall(function () {
        var p = el.position();
        return { x: Math.round(p[0]), y: Math.round(p[1]) };
      }, null);
    }

    function walk(el, depth) {
      if (pressedInfo) return;
      if (depth > 14) return;

      var elRoleStr = elRole(el);
      if (wantRoleSet[elRoleStr]) {
        var nm = elName(el);
        var matchesName = !namePartial || nm.toLowerCase().indexOf(namePartial) !== -1;
        if (matchesName) {
          matchCount.n++;
          if (matchCount.n === targetIndex) {
            var pos = elPos(el);
            pressedInfo = { role: elRoleStr, name: nm, x: pos ? pos.x : null, y: pos ? pos.y : null };
            try {
              el.click();
              pressOk = true;
            } catch (e) {
              pressOk = false;
              pressErr = String(e);
            }
            return;
          }
        }
      }

      var children;
      try { children = el.uiElements(); } catch (e) { return; }
      for (var i = 0; i < children.length && !pressedInfo; i++) {
        try { walk(children[i], depth + 1); } catch (e) { /* skip broken node */ }
      }
    }

    try {
      var windows = proc.windows();
      if (windows.length === 0) return { error: "no windows for " + appName };
      walk(windows[0], 0);
    } catch (e) {
      return { error: "walk failed: " + e };
    }

    if (!pressedInfo) {
      return { error: "no match at index " + targetIndex + " for role=" + opts.role + " name=" + opts.name };
    }
    if (!pressOk) {
      return { error: "AXPress failed: " + pressErr, element: pressedInfo };
    }
    return { ok: true, element: pressedInfo };
  }

  function activate(appName) {
    try {
      Application(appName).activate();
      return { ok: true, app: appName };
    } catch (e) {
      return { error: "could not activate " + appName + ": " + e };
    }
  }

  // Three modes, in precedence order:
  //  1. opts.atX/atY given (a QUARTZ/AX-space point -- origin top-left of
  //     the primary display, y increasing downward, the same space
  //     window.screenX/screenY and AX window positions use): find the
  //     NSScreen.screens entry whose frame actually CONTAINS that point,
  //     and return ITS backingScaleFactor. This is what `dom`'s zoom
  //     normalization needs on a multi-monitor setup -- reading
  //     NSScreen.mainScreen's scale unconditionally is wrong whenever the
  //     browser window sits on a DIFFERENT display than mainScreen (e.g.
  //     a 2x retina built-in panel used alongside a 1x external), it
  //     silently mis-scales zoom_factor by 2x/0.5x even at 100% zoom.
  //  2. opts.index given: NSScreen.screens[index] directly -- best-effort
  //     for multi-display setups, NSScreen.screens ordering is NOT
  //     guaranteed to match screencapture's -D numbering 1:1, see the
  //     caveat in desktop's screen_width_points()/cmd_screenshot.
  //  3. neither given: NSScreen.mainScreen, always correct for itself but
  //     WRONG for a window that isn't on the main display.
  function screenInfo(opts) {
    opts = opts || {};
    var screen, trustworthy = null, screenIndex = null;

    if (typeof opts.atX === "number" && typeof opts.atY === "number") {
      // NSScreen.frame is COCOA screen space (origin bottom-left of the
      // primary display, y increasing upward) -- the opposite Y direction
      // from the Quartz/AX space the caller's point is in. Flip using the
      // primary screen's height as the constant: this is the standard,
      // display-independent Quartz<->Cocoa transform (cocoaY =
      // mainScreenHeight - quartzY), true globally across all displays,
      // not something that needs to be computed per target screen.
      var mainH = $.NSScreen.mainScreen.frame.size.height;
      var cocoaY = mainH - opts.atY;
      var screens = $.NSScreen.screens;
      for (var i = 0; i < screens.count; i++) {
        var s = screens.objectAtIndex(i);
        var f = s.frame;
        if (opts.atX >= f.origin.x && opts.atX < f.origin.x + f.size.width &&
            cocoaY >= f.origin.y && cocoaY < f.origin.y + f.size.height) {
          screen = s; screenIndex = i; trustworthy = true;
          break;
        }
      }
      if (!screen) {
        // Point matched no screen (rounding at a display edge, or a
        // window dragged fully off all displays) -- fall back to
        // mainScreen but mark it explicitly UNTRUSTWORTHY so the caller
        // skips zoom scaling rather than risk mis-scaling by 2x on a
        // guessed screen. Per Codex review: skip/warn beats guess here.
        screen = $.NSScreen.mainScreen;
        trustworthy = false;
      }
    } else if (opts.index === null || opts.index === undefined) {
      screen = $.NSScreen.mainScreen;
    } else {
      var screensByIdx = $.NSScreen.screens;
      if (opts.index < 0 || opts.index >= screensByIdx.count) {
        return { error: "no display at index " + opts.index + " (" + screensByIdx.count + " display(s) reported)" };
      }
      screen = screensByIdx.objectAtIndex(opts.index);
      screenIndex = opts.index;
    }

    var frame = screen.frame;
    var mainHeight = $.NSScreen.mainScreen.frame.size.height;
    // Cocoa frame.origin is bottom-left, y increasing upward. Quartz/AX space
    // (what window.screenX/screenY, AX window positions, and cliclick all
    // use) is top-left origin, y increasing downward. The screen's top-left
    // corner in quartz space is what a bounds guard against a window/click
    // point (also quartz space) needs, so it's computed here once rather
    // than re-derived per caller: quartzOriginY = mainHeight - (cocoaY + h).
    var out = {
      widthPoints: Math.round(frame.size.width),
      heightPoints: Math.round(frame.size.height),
      backingScaleFactor: screen.backingScaleFactor,
      originXQuartz: Math.round(frame.origin.x),
      originYQuartz: Math.round(mainHeight - (frame.origin.y + frame.size.height))
    };
    if (trustworthy !== null) out.trustworthy = trustworthy;
    if (screenIndex !== null) out.screenIndex = screenIndex;
    return out;
  }

  var out;
  if (command === "list-apps") out = listApps();
  else if (command === "windows") out = getWindows(args.app);
  else if (command === "find") out = findElements(args);
  else if (command === "press") out = pressByQuery(args);
  else if (command === "activate") out = activate(args.app);
  else if (command === "screen") out = screenInfo(args);
  else out = { error: "unknown command: " + command };

  return JSON.stringify(out);
}
