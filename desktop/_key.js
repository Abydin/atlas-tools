// _key.js -- key combo dispatcher, invoked by osascript -l JavaScript.
// Not meant to be called directly; the `desktop` python executable shells
// out to this file for the `key` subcommand.
//
// Usage (internal): osascript -l JavaScript _key.js <jsonArgsString>
// jsonArgsString: {"key":"t","cmd":true,"shift":false,"option":false,"control":false}
// "key" may be a plain character (keystroke) or a named key (key code):
//   return, enter, tab, space, delete, escape/esc, left, right, up, down,
//   home, end, pageup, pagedown, forwarddelete

function run(argv) {
  var args = {};
  try { args = JSON.parse(argv[0] || "{}"); } catch (e) { /* default {} */ }

  var key = args.key;
  if (!key) return JSON.stringify({ error: "no key given" });

  var mods = [];
  if (args.cmd) mods.push("command down");
  if (args.shift) mods.push("shift down");
  if (args.option) mods.push("option down");
  if (args.control) mods.push("control down");

  var namedKeyCodes = {
    "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117
  };

  var SystemEvents = Application("System Events");
  var lowerKey = String(key).toLowerCase();

  try {
    if (namedKeyCodes.hasOwnProperty(lowerKey)) {
      var kc = namedKeyCodes[lowerKey];
      if (mods.length > 0) SystemEvents.keyCode(kc, { using: mods });
      else SystemEvents.keyCode(kc);
    } else {
      if (mods.length > 0) SystemEvents.keystroke(key, { using: mods });
      else SystemEvents.keystroke(key);
    }
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
  return JSON.stringify({ ok: true, key: key, mods: mods });
}
