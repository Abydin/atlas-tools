'use strict';

// Structured form introspection and semantic field setting.
//
// The rest of this browser drives pages by CSS selector: `click('#foo')`,
// `fill('#bar', 'x')`. That is fine when a caller already knows the page. It
// is useless for a generic form runner, whose whole problem is the opposite:
// it arrives at a form it has never seen, on one of many different hosts,
// and has to work out what the fields MEAN before it can fill anything. So
// the primitive that was missing is not another way to click, it is a way
// to ASK the page what it is asking for.
//
// `scanForm()` returns a structured description of every control: its label
// (resolved through six fallbacks, because a large share of real web forms
// do not use <label for>), whether it is required, its options, and a stable
// ref. `setField()` then writes a value through the right mechanism for the
// control type, including the non-native comboboxes that several popular
// form platforms ship instead of <select>.
//
// SECURITY: nothing here accepts caller-supplied JavaScript. The page-side
// functions below are fixed, and the only caller-controlled values that cross
// into the page are a field ref (matched against a data attribute this module
// itself assigned) and a string value. That is deliberate: exposing a generic
// `evaluate(userJS)` over the HTTP API would hand any hostile page that could
// talk a god into relaying a string a full code-execution primitive inside a
// browser holding the operator's logged-in cookies.

const FIELD_ATTR = 'data-atlas-field';

// ---------------------------------------------------------------------------
// PAGE-SIDE: serialized into the page by Playwright. Must be self-contained,
// no closure over anything in this file.
// ---------------------------------------------------------------------------

/* eslint-disable */
function pageScanForm(fieldAttr) {
  const CONTROL_SEL = 'input, textarea, select, [role="combobox"], [role="listbox"]';
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);

  function visible(el) {
    if (!el || !el.getClientRects) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // File inputs are routinely 1x1 or opacity:0 behind a styled button, and
    // they are exactly the control we most need to find. Treat them as
    // visible if they are in the DOM and not display:none.
    if (el.tagName === 'INPUT' && el.type === 'file') return true;
    return el.getClientRects().length > 0;
  }

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // Six fallbacks, in descending order of trustworthiness. Real forms use all
  // six; some platforms use <label for>, others use aria-labelledby, some
  // lean on placeholder, and a few custom-built forms have nothing but a
  // <div> of text sitting above the input.
  function labelFor(el) {
    // 1. explicit <label for="id">
    if (el.id) {
      const esc = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"');
      const l = document.querySelector('label[for="' + esc + '"]');
      if (l && clean(l.innerText)) return { text: clean(l.innerText), via: 'label[for]' };
    }
    // 2. wrapping <label>
    const wrap = el.closest('label');
    if (wrap && clean(wrap.innerText)) return { text: clean(wrap.innerText), via: 'wrapping-label' };
    // 3. aria-labelledby
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\s+/).map(function (id) {
        const n = document.getElementById(id);
        return n ? clean(n.innerText || n.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return { text: parts.join(' '), via: 'aria-labelledby' };
    }
    // 4. aria-label
    const al = clean(el.getAttribute('aria-label'));
    if (al) return { text: al, via: 'aria-label' };
    // 5. placeholder
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return { text: ph, via: 'placeholder' };
    // 6. nearest preceding text in the same field group. Walk up a few
    // levels and take the first non-empty text node block that is not itself
    // another control's text.
    let node = el;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      node = node.parentElement;
      if (!node) break;
      const clone = node.cloneNode(true);
      clone.querySelectorAll(CONTROL_SEL + ', option, script, style').forEach(function (n) { n.remove(); });
      const t = clean(clone.innerText || clone.textContent);
      if (t && t.length <= 300) return { text: t, via: 'ancestor-text-depth-' + depth };
    }
    return { text: '', via: 'none' };
  }

  function requiredOf(el, label) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    // Very common pattern: the asterisk lives in the label, not the input.
    if (/\*\s*$/.test(label) || /\(required\)/i.test(label)) return true;
    const group = el.closest('[class*="required"], [data-required="true"]');
    if (group) return true;
    return false;
  }

  // Walk up from one radio input until an ancestor carries text beyond the
  // options themselves; that leftover text is the question.
  function groupQuestion(el) {
    const groupName = el.name;
    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      node = node.parentElement;
      if (!node) break;
      const clone = node.cloneNode(true);
      // Drop every radio in this group along with its own label text, so what
      // remains is the surrounding question rather than "Yes No".
      clone.querySelectorAll('input[type="radio"]').forEach(function (r) {
        const own = r.closest('label');
        if (own && own !== clone) own.remove();
        else r.remove();
      });
      clone.querySelectorAll('script, style').forEach(function (n) { n.remove(); });
      const t = clean(clone.innerText || clone.textContent);
      if (t && t.length >= 4 && t.length <= 300) return t;
      if (groupName && depth >= 5) break;
    }
    return '';
  }

  const controls = Array.prototype.slice.call(document.querySelectorAll(CONTROL_SEL));
  const fields = [];
  let seq = 0;

  // Radio groups collapse into one logical field keyed by name.
  const radioGroups = {};

  controls.forEach(function (el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && SKIP_TYPES.has(type)) return;
    if (!visible(el)) return;
    // A [role=combobox] that IS an input is already covered by the input pass.
    if (el.hasAttribute('role') && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      // fall through, handled below with its real tag
    }

    const lab = labelFor(el);

    if (tag === 'input' && type === 'radio') {
      const key = el.name || 'radio-' + seq;
      if (!radioGroups[key]) {
        seq += 1;
        const ref = 'f' + seq;
        el.setAttribute(fieldAttr, ref);
        radioGroups[key] = {
          ref: ref,
          kind: 'radio',
          name: el.name || '',
          // A radio GROUP's label is the question, which lives above the
          // options and belongs to none of them. Resolving it needs a
          // different walk from a single input's label: go up until an
          // ancestor holds text that is not merely the option texts. Without
          // this, radio groups came back with an empty label and the runner
          // could not tell "which role are you applying for" from an
          // unrelated yes/no question.
          label: groupQuestion(el),
          required: false,
          options: [],
        };
        fields.push(radioGroups[key]);
      }
      radioGroups[key].options.push({ value: el.value, text: lab.text });
      // Fail closed: if the extracted "question" is really just one of the
      // option texts, the walk did not find the question (Notion's markup
      // does not wrap radios in <label>, so the option text could not be
      // stripped out). An empty label is honest and makes the caller
      // escalate; a wrong label would make it answer the wrong question.
      const g = radioGroups[key];
      if (g.label && g.options.some(function (o) { return o.text && o.text === g.label; })) {
        g.label = '';
      }
      if (el.required) radioGroups[key].required = true;
      return;
    }

    seq += 1;
    const ref = 'f' + seq;
    el.setAttribute(fieldAttr, ref);

    let kind;
    if (tag === 'select') kind = 'select';
    else if (tag === 'textarea') kind = 'textarea';
    else if (type === 'file') kind = 'file';
    else if (type === 'checkbox') kind = 'checkbox';
    else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') kind = 'combobox';
    else kind = 'text';

    const f = {
      ref: ref,
      kind: kind,
      tag: tag,
      type: type || null,
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label: lab.text,
      labelVia: lab.via,
      required: requiredOf(el, lab.text),
      value: kind === 'checkbox' ? !!el.checked : (el.value || ''),
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
      accept: el.getAttribute('accept') || null,
      options: null,
    };

    if (kind === 'select') {
      f.options = Array.prototype.slice.call(el.options).map(function (o) {
        return { value: o.value, text: clean(o.text) };
      });
    }

    fields.push(f);
  });

  // Submit candidates, ranked. Ordered so the caller does not have to guess.
  const submitSel = 'button[type="submit"], input[type="submit"], button, [role="button"]';
  const submits = [];
  let sseq = 0;
  Array.prototype.slice.call(document.querySelectorAll(submitSel)).forEach(function (el) {
    if (!visible(el)) return;
    const text = clean(el.innerText || el.value || el.getAttribute('aria-label'));
    if (!text) return;
    sseq += 1;
    const ref = 's' + sseq;
    el.setAttribute(fieldAttr, ref);
    let score = 0;
    const t = text.toLowerCase();
    if (/^(submit|apply|send|submit application|apply now|send application)\b/.test(t)) score += 10;
    if (/\b(submit|apply)\b/.test(t)) score += 5;
    // Non-English boards are not an edge case in this queue: join.com served
    // a German posting whose only apply control was "Jetzt bewerben", which
    // scored 0 against English-only patterns and made the lead unresolvable.
    if (/\b(bewerben|jetzt bewerben|postuler|candidature|solicitar|postular|candidatar|invia candidatura|absenden|enviar)\b/.test(t)) score += 10;
    // "Later" variants are a save-for-later, not a submit (German "Später
    // bewerben" outscored the real button before this).
    if (/\b(sp(a|ä)ter|later|save for later|merken)\b/.test(t)) score -= 25;
    if ((el.getAttribute('type') || '').toLowerCase() === 'submit') score += 4;
    if (el.closest('form')) score += 2;
    if (/\b(cancel|back|close|save draft|sign in|log in)\b/.test(t)) score -= 20;
    // Third-party auth and autofill buttons read exactly like a submit
    // ("Continue with a social account") but hand the user to an OAuth flow
    // instead of submitting anything. Some real forms put one directly
    // above the real submit, and it outranked it on the first live dry run.
    if (/\b(with|using)\s+(google|github|facebook|apple|microsoft|okta|sso)\b/.test(t)) score -= 40;
    if (/\b(autofill|upload|attach|choose file|browse)\b/.test(t)) score -= 30;
    submits.push({ ref: ref, text: text, score: score, disabled: !!el.disabled });
  });
  submits.sort(function (a, b) { return b.score - a.score; });

  // Captcha widgets live inside cross-origin iframes, so their challenge text
  // never reaches document.body.innerText. Detecting them needs the iframe
  // itself. Without this, an hCaptcha that appeared AFTER clicking submit on
  // a real form looked like an ambiguous "no confirmation seen" result rather
  // than the hard blocker it is.
  const captchaEl = document.querySelector(
    'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i], '
    + '.h-captcha, .g-recaptcha, [data-hcaptcha-widget-id], [data-sitekey]'
  );

  return {
    url: location.href,
    title: document.title,
    captcha: !!captchaEl,
    formCount: document.querySelectorAll('form').length,
    fields: fields,
    submits: submits,
    bodyText: (document.body ? document.body.innerText : '').slice(0, 20000),
  };
}

// RESOLVE stage support. Getting from a landing URL to "the actual target
// form" is mostly a link-following problem, and `readText` throws hrefs
// away. This returns them with their anchor text so a caller can rank
// candidates (e.g. "Apply", "Start", "Continue") without guessing.
function pageScanLinks() {
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  const out = [];
  const seen = {};
  Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
    let href;
    try { href = new URL(a.getAttribute('href'), location.href).href; } catch (e) { return; }
    if (!/^https?:/.test(href)) return;
    const text = clean(a.innerText || a.getAttribute('aria-label') || a.title);
    const key = href + '|' + text;
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ href: href, text: text.slice(0, 200) });
  });
  return out;
}

function pageSetField(args) {
  const el = document.querySelector('[' + args.fieldAttr + '="' + args.ref + '"]');
  if (!el) return { ok: false, error: 'field ref not found: ' + args.ref };

  function fire(node, names) {
    names.forEach(function (n) {
      node.dispatchEvent(new Event(n, { bubbles: true }));
    });
  }

  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();

  if (tag === 'select') {
    const want = String(args.value).toLowerCase();
    let matched = null;
    // exact value, then exact text, then contains-text.
    for (let i = 0; i < el.options.length; i += 1) {
      const o = el.options[i];
      if (o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) { matched = o; break; }
    }
    if (!matched) {
      for (let i = 0; i < el.options.length; i += 1) {
        const o = el.options[i];
        if (o.text.trim().toLowerCase().indexOf(want) !== -1) { matched = o; break; }
      }
    }
    if (!matched) {
      return {
        ok: false,
        error: 'no option matching ' + JSON.stringify(args.value),
        options: Array.prototype.slice.call(el.options).map(function (o) { return o.text.trim(); }),
      };
    }
    el.value = matched.value;
    fire(el, ['input', 'change']);
    return { ok: true, set: matched.text.trim() };
  }

  if (type === 'checkbox' || type === 'radio') {
    const want = args.value === true || args.value === 'true' || args.value === 'on';
    if (type === 'radio') {
      // For a radio group ref, pick the input whose value/label matches.
      //
      // Label resolution here MUST match the same fallback chain the scanner
      // uses to build field.options[].text (see labelFor() above), not just
      // el.closest('label'). Custom accessible radio widgets (EEO / demographic
      // self-ID questions among them, on real production forms) associate their option text
      // via label[for], aria-labelledby, or aria-label, never a wrapping
      // <label>. A closest('label')-only check silently found nothing for
      // those, so a correctly-detected "Decline to self-identify" option
      // (found by fill.js at scan time via the richer walk) failed to click
      // here and fell through to an escalation - the exact bug that made EEO
      // questions escalate instead of auto-declining. Root-caused 2026-07-28.
      function radioLabelText(node) {
        if (node.id) {
          const esc = (window.CSS && CSS.escape) ? CSS.escape(node.id) : node.id.replace(/"/g, '\\"');
          const l = document.querySelector('label[for="' + esc + '"]');
          if (l && l.innerText.trim()) return l.innerText.trim();
        }
        const wrap = node.closest('label');
        if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
        const lb = node.getAttribute('aria-labelledby');
        if (lb) {
          const parts = lb.split(/\s+/).map(function (id) {
            const n = document.getElementById(id);
            return n ? (n.innerText || n.textContent || '').trim() : '';
          }).filter(Boolean);
          if (parts.length) return parts.join(' ');
        }
        const al = (node.getAttribute('aria-label') || '').trim();
        if (al) return al;
        // Last resort: nearest ancestor text, one level up, controls removed.
        const parent = node.parentElement;
        if (parent) {
          const clone = parent.cloneNode(true);
          clone.querySelectorAll('input, select, textarea, button').forEach(function (n) { n.remove(); });
          const t = (clone.innerText || clone.textContent || '').trim();
          if (t && t.length <= 200) return t;
        }
        return '';
      }
      const group = document.querySelectorAll('input[type="radio"][name="' + el.name + '"]');
      const target = String(args.value).toLowerCase();
      for (let i = 0; i < group.length; i += 1) {
        const r = group[i];
        const lbl = radioLabelText(r).toLowerCase();
        if (r.value.toLowerCase() === target || lbl === target || lbl.indexOf(target) !== -1) {
          r.checked = true;
          fire(r, ['input', 'change', 'click']);
          return { ok: true, set: r.value };
        }
      }
      return { ok: false, error: 'no radio option matching ' + JSON.stringify(args.value) };
    }
    el.checked = want;
    fire(el, ['input', 'change', 'click']);
    return { ok: true, set: want };
  }

  if (tag === 'input' || tag === 'textarea') {
    // React and friends install a value setter on the prototype and ignore
    // direct .value writes for state purposes. Use the native setter then
    // fire input, which is what React's onChange actually listens for.
    const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, String(args.value));
    else el.value = String(args.value);
    fire(el, ['input', 'change']);
    return { ok: true, set: String(args.value).slice(0, 80) };
  }

  return { ok: false, error: 'unsupported control: ' + tag + '/' + type };
}

function pageReadValues(fieldAttr) {
  const out = {};
  Array.prototype.slice.call(document.querySelectorAll('[' + fieldAttr + ']')).forEach(function (el) {
    const ref = el.getAttribute(fieldAttr);
    if (ref[0] !== 'f') return;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox') out[ref] = !!el.checked;
    else if (type === 'file') out[ref] = (el.files && el.files.length) ? el.files[0].name : '';
    else out[ref] = el.value || '';
  });
  return out;
}
/* eslint-enable */

// ---------------------------------------------------------------------------
// NODE-SIDE
// ---------------------------------------------------------------------------

// A combobox that is not a native <select> (a common pattern on modern
// form platforms) cannot be set by writing .value: the visible input is a filter and
// the real value lives in framework state, only reachable by actually opening
// the list and clicking an option. So this path is deliberately a real user
// interaction rather than a DOM write.
// Builds the option-list selector, scoped to THIS combobox's own listbox
// when the widget publishes one via aria-controls. Root-caused on a real
// production form: its "Country*" field is not the ordinary
// plain-country-name react-select (Country/Location/work-auth) - it shares
// implementation with the PHONE field's dial-code picker (intl-tel-input),
// which renders its own 240+ option list of every country+dial-code INLINE
// AND ALWAYS-PRESENT in the DOM, not just when opened. The page-wide
// optionSel query below picked up all of those unrelated options alongside
// the real widget's own (currently open) list, so the exact/partial match
// and the pickIndex ArrowDown-count were computed against a contaminated
// array - on a plain-text-option widget ("current country of
// residence") this happened to still work because an exact match ("Kenya")
// only ever exists once, in the widget's own list, and the resulting large
// but still-in-bounds ArrowDown count converges on the same single filtered
// option anyway; on a real dial-code widget there was no exact match
// (its own option text is "Kenya +254", identical in shape to the
// contaminating phone-widget entries), so an unrelated, unfocused element
// won the match and the real, focused widget got zero ArrowDown presses -
// which happened to still open ON the right option by geoip-default, but
// see below for why that still reads as a failure. Scoping to
// aria-controls, when the widget exposes it (react-select always does),
// removes the contamination at the source rather than patching around it.
const GENERIC_OPTION_SEL = '[role="option"], [role="listbox"] li, .pac-item, '
  + '.select__option, [class*="option"]:not([class*="options"])';

// Reads the option-like elements for a combobox, scoped to its OWN listbox
// (via aria-controls -> getElementById, never a raw CSS-selector string
// built from page-supplied text, so nothing about the id needs escaping)
// when the widget publishes one. Falls back to a page-wide query for
// widgets that do not (e.g. a plain non-ARIA custom dropdown), which is
// exactly today's pre-existing behavior for those.
async function optionElementsFor(page, sel) {
  const controlsId = await page.getAttribute(sel, 'aria-controls').catch(() => null);
  if (controlsId) {
    // Attribute-value selector, not a `#id` identifier selector - the id
    // string came off the page (a widget's own aria-controls) and an
    // attribute-value match needs no CSS-identifier escaping the way a raw
    // `#${id}` selector would.
    const els = await page.$$(`[id="${controlsId}"] [role="option"], [id="${controlsId}"] li`);
    if (els.length) return els;
  }
  return page.$$(GENERIC_OPTION_SEL);
}

async function setCombobox(page, ref, value) {
  const sel = `[${FIELD_ATTR}="${ref}"]`;
  await page.click(sel, { timeout: 8000 });
  await page.waitForTimeout(250);

  // Real keystrokes, not a single .fill(). This is the fix for the Ondo
  // Finance Country/Location comboboxes escalating with "no combobox option
  // matching the typed city": .fill() writes the value once via the native setter and
  // fires 'input'/'change', which is all a plain controlled <input> needs,
  // but some type-to-search Country/Location widgets filter (and for
  // Location, re-query a geocoder) off real per-character keyboard events.
  // A value that lands with no keydown/keyup behind it never triggers that
  // filter, so the option list stays empty and the later search always comes
  // up short. Typing it out character by character is what a human user
  // does, and it is what these widgets are built to listen for.
  try {
    await page.click(sel, { clickCount: 3, timeout: 3000 }); // select any existing text
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(String(value), { delay: 60 });
  } catch {
    // Some comboboxes are non-editable divs (no real text caret to type
    // into); fall back to whatever option list is already open/rendered.
  }

  // Options can take a beat to render. A fixed wait was long enough for a
  // static in-page list but not for Location, which is backed by a real
  // geocoding lookup - the old single 500ms check came back empty on a
  // slower round trip and reported "no option matching" on a field that
  // resolved a moment later. Poll instead of guessing one wait length.
  let options = [];
  const deadline = Date.now() + 4000;
  let nudged = false;
  while (Date.now() < deadline) {
    options = await optionElementsFor(page, sel);
    if (options.length) break;
    // A click that opens the widget but a typed filter that renders nothing
    // yet: nudge it once with ArrowDown, which is enough to force several
    // custom listboxes to materialize their (already-filtered) option list.
    if (!nudged) {
      nudged = true;
      await page.keyboard.press('ArrowDown').catch(() => {});
    }
    await page.waitForTimeout(250);
  }

  const want = String(value).trim().toLowerCase();
  let exact = null;
  let exactIndex = -1;
  let partial = null;
  let partialIndex = -1;
  for (let i = 0; i < options.length; i += 1) {
    const t = ((await options[i].innerText().catch(() => '')) || '').trim().toLowerCase();
    if (!t) continue;
    if (t === want) { exact = options[i]; exactIndex = i; break; }
    if (!partial && t.includes(want)) { partial = options[i]; partialIndex = i; }
  }
  const pick = exact || partial;
  const pickIndex = exact ? exactIndex : partialIndex;
  if (!pick) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, error: `no combobox option matching ${JSON.stringify(value)}` };
  }
  // Captured now, before Enter closes the menu and the option node is gone -
  // this is the ground truth for the dial-code-style fallback check below,
  // not a guess at what the widget "should" show.
  const pickText = ((await pick.innerText().catch(() => '')) || '').trim();

  // A plain pick.click() looked like it worked (the widget's own display
  // swapped "Select..." for the chosen text right afterwards) but the value
  // never actually reached the site's controlled form state: root-caused
  // live on a real react-select board by watching the SAME
  // combobox revert to "Select..." the moment ANY other field on the page
  // was touched next - not just another combobox, a plain text field and
  // even clicking an unrelated heading reproduced it. That means pick.click()
  // was landing on a rendering that reflected the option only in the
  // widget's own local/uncontrolled state, never in the parent's onChange,
  // so the very next re-render (triggered by literally any other
  // interaction) reasserted the real, still-empty controlled value. Real
  // react-select keyboard selection (ArrowDown to the highlighted option,
  // then Enter) goes through the same onKeyDown handler a sighted human
  // uses and is what actually fires the commit. Try that FIRST; only fall
  // back to the click if the keyboard path cannot reach the option (a
  // handful of non-react-select custom widgets have no keyboard model at
  // all and only respond to a direct click).
  for (let i = 0; i < pickIndex; i += 1) {
    await page.keyboard.press('ArrowDown').catch(() => {});
  }
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(250);

  // VERIFY, don't assume: force a blur (the exact trigger that exposed the
  // bug - any subsequent interaction re-renders the widget from its real
  // controlled value) and confirm the chosen text survives it. A selection
  // that was only ever local/uncontrolled state reverts to "Select..." the
  // instant focus leaves the widget; a genuinely committed one does not.
  await page.keyboard.press('Tab').catch(() => {});
  await page.waitForTimeout(200);
  let stuck = await comboboxCommitted(page, sel, value, pickText);

  if (!stuck) {
    // Keyboard selection did not stick either. Retry once with the original
    // click, in case this particular widget is one of the non-react-select
    // custom dropdowns that only responds to a direct pointer event and has
    // no keydown handler at all - re-open, re-filter, click, then verify the
    // same way rather than trusting the click blindly as the old code did.
    await page.click(sel, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(200);
    try {
      await page.click(sel, { clickCount: 3, timeout: 2000 });
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(String(value), { delay: 60 });
    } catch {
      // non-editable widget; whatever list is already open is all we get.
    }
    let retryOptions = [];
    const retryDeadline = Date.now() + 3000;
    while (Date.now() < retryDeadline) {
      retryOptions = await optionElementsFor(page, sel);
      if (retryOptions.length) break;
      await page.waitForTimeout(250);
    }
    let retryPick = null;
    let retryPickText = '';
    for (const o of retryOptions) {
      const raw = ((await o.innerText().catch(() => '')) || '').trim();
      const t = raw.toLowerCase();
      if (t === want || (!retryPick && t.includes(want))) { retryPick = o; retryPickText = raw; }
      if (t === want) break;
    }
    if (retryPick) {
      await retryPick.click().catch(() => {});
      await page.waitForTimeout(250);
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(200);
      stuck = await comboboxCommitted(page, sel, value, retryPickText);
    }
  }

  if (!stuck) {
    return {
      ok: false,
      error: `combobox appeared to accept ${JSON.stringify(value)} but the selection did not survive a `
        + 'blur/re-render - it was never really committed, not a truthful fill',
    };
  }
  // `displayed` is the widget's own actual post-commit text (e.g. "+254" on
  // the dial-code-style Country field, same text `set` on an ordinary
  // text-option combobox) - callers that need to verify this commit AGAIN
  // later (a caller's own post-fill stabilization pass) must compare against this,
  // not the semantic `set` value, or a truthful dial-code-style commit
  // reads as "reverted" on every later check forever, see comboboxCommitted.
  const displayed = (await widgetDisplayText(page, sel)) || String(value);
  return { ok: true, set: String(value), displayed };
}

// Reads back whatever text the combobox's own container is actually
// displaying (not the search <input>'s .value, which react-select clears
// after every pick regardless of whether the selection stuck) and reports
// whether it matches the value we asked for. This is the ground truth check
// setCombobox uses to tell a real commit from a visual-only flash.
async function comboboxShowsValue(page, sel, value) {
  const want = String(value).trim().toLowerCase();
  return page.evaluate(({ selector, wantText }) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    // Walk up to a reasonably-sized container (the combobox's control
    // wrapper) rather than reading document.body, so a match elsewhere on
    // the page for the same word cannot produce a false positive.
    let node = el;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const text = (node.innerText || node.textContent || '').trim().toLowerCase();
      if (text && text.length < 500) {
        if (text.includes(wantText) && !/^select\.{0,3}$/.test(text)) return true;
      }
      node = node.parentElement;
    }
    return false;
  }, { selector: sel, wantText: want });
}

// Same ancestor walk as comboboxShowsValue, but returns the raw displayed
// text (or '' if nothing legible/still the placeholder) instead of a
// yes/no against one expected string. Used by comboboxCommitted() below to
// ground-truth widgets whose collapsed display legitimately never contains
// the search text.
async function widgetDisplayText(page, sel) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return '';
    let node = el;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const text = (node.innerText || node.textContent || '').trim();
      if (text && text.length < 500 && !/^select\.{0,3}$/i.test(text)) return text;
      node = node.parentElement;
    }
    return '';
  }, sel);
}

// Ground-truth "did the pick genuinely commit" check. The plain
// comboboxShowsValue (does the widget now display the value we searched
// for) is correct for ordinary text-option comboboxes (Country, Location,
// work-auth) and is tried first. It is wrong for the one widget shape
// found on a real production form: the "Country*" field
// shares its option renderer with the phone number's dial-code picker, so
// its collapsed display legitimately shows only "+254", never "Kenya",
// no matter how correctly the pick is made - see optionElementsFor's
// comment for how this was proven (a hand-scoped click straight on the
// widget's own, uncontaminated option still collapses to "+254"). For that
// shape, the honest ground truth is not "does it say what I searched for"
// but "does it now show something that is unambiguously the option I just
// picked" - i.e. the widget's post-commit display is a genuine substring
// of the EXACT option text captured at pick time (not a guess at what a
// dial code "should" be, and not satisfied by an untouched placeholder).
async function comboboxCommitted(page, sel, value, pickText) {
  if (await comboboxShowsValue(page, sel, value)) return true;
  if (!pickText) return false;
  const shown = (await widgetDisplayText(page, sel)).trim().toLowerCase();
  if (!shown) return false;
  return pickText.trim().toLowerCase().includes(shown);
}

async function scanForm(page) {
  return page.evaluate(pageScanForm, FIELD_ATTR);
}

// Check-only verify: does the combobox at `ref` currently DISPLAY `value`,
// with zero click/type interaction. Reuses the exact ground-truth signal
// setCombobox()'s own post-commit verify trusts (comboboxShowsValue), so a
// caller that needs to know whether a previously-committed combobox has
// since reverted (a caller's own post-fill stabilization pass) gets a
// truthful read. A plain formScan() cannot answer this: pageScanForm reads
// the raw input's .value, and react-select-style widgets clear that back
// to "" the instant any pick commits, so a freshly-committed "Kenya" and an
// untouched widget read identically on that field. That made stabilizeCombos
// misjudge a genuinely-committed combobox as reverted on every round it
// checked - a real bug in its own right, on top of (and independent of) the
// dominant cause of the 2026-08-11 Country/Location/work-auth regression:
// lib/atlas-browser.js formSet()'s fillable fast-path routing every
// combobox around setCombobox() entirely (see its comment).
async function checkComboboxValue(page, ref, value) {
  const sel = selectorForRef(ref);
  return comboboxShowsValue(page, sel, value);
}

async function setField(page, ref, value) {
  // Native path first. Combobox refs come back from the scan already tagged,
  // so route on the scanned kind rather than re-sniffing here.
  const kind = await page.evaluate((args) => {
    const el = document.querySelector(`[${args.attr}="${args.ref}"]`);
    if (!el) return null;
    if (el.tagName.toLowerCase() === 'select') return 'select';
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
    return 'native';
  }, { attr: FIELD_ATTR, ref });

  if (kind === null) return { ok: false, error: `field ref not found: ${ref}` };
  if (kind === 'combobox') return setCombobox(page, ref, value);
  return page.evaluate(pageSetField, { fieldAttr: FIELD_ATTR, ref, value });
}

async function scanLinks(page) {
  return page.evaluate(pageScanLinks);
}

async function readValues(page) {
  return page.evaluate(pageReadValues, FIELD_ATTR);
}

function selectorForRef(ref) {
  return `[${FIELD_ATTR}="${ref}"]`;
}

module.exports = {
  scanForm, scanLinks, setField, readValues, selectorForRef, checkComboboxValue, FIELD_ATTR,
};
