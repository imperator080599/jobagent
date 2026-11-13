/*
 * JobAgent — lecture et remplissage des formulaires de candidature.
 * Exécuté dans la page : par le pilote de navigateur (Playwright) et par l'extension.
 * Aucune dépendance. N'envoie rien nulle part : il lit le formulaire et le remplit.
 * Il ne contourne aucun CAPTCHA, aucune connexion, aucune protection : il les signale.
 */
(() => {
  if (window.__ja && window.__ja.version === 2) return;
  const N = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const T = (el) => (el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let seq = 0;
  const keyOf = (el) => {
    let k = el.getAttribute('data-ja-key');
    if (!k) {
      k = `f${++seq}`;
      while (document.querySelector(`[data-ja-key="${k}"]`)) k = `f${++seq}`;
      el.setAttribute('data-ja-key', k);
    }
    return k;
  };
  const byIds = (ids) =>
    String(ids)
      .split(/\s+/)
      .map((id) => T(document.getElementById(id)))
      .filter(Boolean)
      .join(' ');
  const ownText = (node, exclude) => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('input,select,textarea,button,[role=listbox],[role=option]').forEach((n) => n.remove());
    if (exclude) clone.querySelectorAll('[data-ja-key]').forEach((n) => n.remove());
    return T(clone);
  };
  const LABELISH = 'label, legend, [class*="label" i], [class*="question" i], [class*="title" i], p, span, h1, h2, h3, h4, h5, h6, div';

  function labelOf(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = byIds(lb);
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && ownText(l)) return ownText(l);
    }
    const wrap = el.closest('label');
    if (wrap && ownText(wrap)) return ownText(wrap);
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    // Libellé voisin : premier élément textuel qui précède le champ dans ses conteneurs proches.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      for (const c of Array.from(node.children)) {
        if (c.contains(el)) break;
        if (!c.matches(LABELISH) || c.querySelector('input,select,textarea')) continue;
        const t = T(c);
        if (t && t.length <= 300) return t;
      }
    }
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
  }

  function groupLabelOf(first, items) {
    const fs = first.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg && T(lg)) return T(lg);
    }
    const rg = first.closest('[role=radiogroup],[role=group]');
    if (rg) {
      if (rg.getAttribute('aria-labelledby')) {
        const t = byIds(rg.getAttribute('aria-labelledby'));
        if (t) return t;
      }
      if (rg.getAttribute('aria-label')) return rg.getAttribute('aria-label');
    }
    let anc = first.parentElement;
    while (anc && !items.every((i) => anc.contains(i))) anc = anc.parentElement;
    let node = anc;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      for (const c of Array.from(node.children)) {
        if (items.some((i) => c.contains(i))) break;
        if (c.querySelector('input,select,textarea')) continue;
        const t = T(c);
        if (t && t.length <= 300) return t;
      }
    }
    return first.name || '';
  }

  function sectionOf(el) {
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend')) return T(fs.querySelector('legend')).slice(0, 120);
    const sec = el.closest('section, [role=group], [class*="section" i]');
    const h = sec && sec.querySelector('h1,h2,h3,h4');
    return h ? T(h).slice(0, 120) : '';
  }

  const isRequired = (el, rawLabel) =>
    el.required ||
    el.getAttribute('aria-required') === 'true' ||
    /[*✱✳]\s*$/.test(rawLabel) ||
    /\((required|obligatoire|requis|obligatorio|pflichtfeld)\)/i.test(rawLabel) ||
    Boolean(el.closest('[data-required="true"], .required, .is-required'));

  const clean = (s) =>
    String(s || '')
      .replace(/\s*[*✱✳]\s*/g, ' ')
      .replace(/\((required|obligatoire|requis|obligatorio|pflichtfeld)\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

  function shownChoice(el) {
    // Une case ou un bouton radio stylé est souvent masqué : son libellé, lui, est visible.
    if (visible(el)) return true;
    const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
    return Boolean(l && visible(l));
  }

  function shownFile(el) {
    // Champ de fichier souvent masqué derrière un bouton : il compte si aucun de ses conteneurs n'est masqué.
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const st = getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
    }
    return true;
  }

  function scanFields() {
    const out = [];
    const groups = new Set();
    const els = Array.from(document.querySelectorAll('input, select, textarea'));
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      let type = tag === 'select' ? (el.multiple ? 'select-multiple' : 'select-one') : tag === 'textarea' ? 'textarea' : (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (el.disabled) continue;
      if (el.getAttribute('role') === 'combobox' && tag === 'input') type = 'combobox';
      if (type === 'file' ? !shownFile(el) : type === 'radio' || type === 'checkbox' ? !shownChoice(el) : !visible(el)) continue;
      if (type === 'radio' || type === 'checkbox') {
        const name = el.name;
        const same = name ? Array.from(document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`)).filter((x) => !x.disabled && shownChoice(x)) : [el];
        if (type === 'radio' || same.length > 1) {
          const gid = `${type}:${name}`;
          if (groups.has(gid)) continue;
          groups.add(gid);
          const raw = groupLabelOf(same[0], same);
          out.push({
            key: keyOf(same[0]),
            tag: 'input',
            type,
            label: clean(raw),
            name,
            id: same[0].id || '',
            required: same.some((x) => x.required) || isRequired(same[0], raw),
            options: same.map((x) => ({ value: x.value && x.value !== 'on' ? x.value : keyOf(x), label: clean(labelOf(x)) })),
            multiple: type === 'checkbox',
            accept: '',
            value: same.filter((x) => x.checked).map((x) => x.value).join(','),
            placeholder: '',
            autocomplete: '',
            section: sectionOf(same[0]),
          });
          same.forEach((x) => keyOf(x));
          continue;
        }
      }
      const raw = labelOf(el);
      const f = {
        key: keyOf(el),
        tag: type === 'combobox' ? 'combobox' : tag,
        type,
        label: clean(raw),
        name: el.name || '',
        id: el.id || '',
        required: isRequired(el, raw),
        options: [],
        multiple: Boolean(el.multiple),
        accept: el.getAttribute('accept') || '',
        value: type === 'checkbox' ? (el.checked ? 'true' : '') : type === 'file' ? Array.from(el.files || []).map((x) => x.name).join(',') : String(el.value || ''),
        checked: type === 'checkbox' ? el.checked : undefined,
        placeholder: el.getAttribute('placeholder') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        section: sectionOf(el),
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      };
      if (tag === 'select') f.options = Array.from(el.options).map((o) => ({ value: o.value, label: T(o) || o.label || o.value }));
      if (type === 'combobox') {
        const lb = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        const list = lb ? document.getElementById(lb) : null;
        if (list) f.options = Array.from(list.querySelectorAll('[role=option]')).map((o) => ({ value: T(o), label: T(o) }));
      }
      out.push(f);
    }
    return out;
  }

  const NEXT = /^(next|continue|continuer|suivant|etape suivante|weiter|siguiente|save (and|&) continue|enregistrer et continuer|review|verifier|valider et continuer)\b/;
  const SUBMIT = /(submit|send( my)? application|envoyer|soumettre|postuler|^apply\b|apply now|candidater|valider (ma|la) candidature|bewerbung (absenden|senden|abschicken)|jetzt bewerben|enviar|solicitar|finish|terminer)/;
  const OPEN = /^(apply|postuler|candidater|je postule|apply (now|for this job)|bewerben|jetzt bewerben|aplicar|inscribirse)\b/;

  function buttons() {
    const all = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], [role=button], a')).filter(visible);
    const text = (b) => N(b.value || T(b) || b.getAttribute('aria-label') || '');
    const inForm = (b) => Boolean(b.closest('form')) || b.type === 'submit';
    const next = all.find((b) => NEXT.test(text(b)) && b.tagName !== 'A');
    // Formulaires sans balise <form> (parcours en une page) : un bouton dont le libellé est sans ambiguïté suffit.
    const STRONG = /^(submit( (my )?application)?|send( my)? application|envoyer( ma candidature)?|soumettre( ma candidature)?|postuler|valider (ma|la) candidature|bewerbung (absenden|senden|abschicken)|enviar( (mi )?(solicitud|candidatura))?)$/;
    const submit = all.find((b) => b.tagName !== 'A' && !NEXT.test(text(b)) && SUBMIT.test(text(b)) && (inForm(b) || b.getAttribute('type') === 'submit' || STRONG.test(text(b))));
    const open = all.find((b) => OPEN.test(text(b)));
    const k = (b) => (b ? keyOf(b) : null);
    return { next: k(next), nextLabel: next ? text(next) : '', submit: k(submit), submitLabel: submit ? text(submit) : '', open: k(open), openHref: open && open.tagName === 'A' ? open.href : '' };
  }

  function captcha() {
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      const src = `${f.src || ''} ${f.title || ''}`;
      if (!/recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha-delivery\.com|geo\.captcha/i.test(src)) continue;
      const r = f.getBoundingClientRect();
      if (visible(f) && r.width > 60 && r.height > 40) {
        const kind = /hcaptcha/i.test(src) ? 'hcaptcha' : /recaptcha/i.test(src) ? 'recaptcha' : /cloudflare|turnstile/i.test(src) ? 'turnstile' : /captcha-delivery|geo\.captcha/i.test(src) ? 'datadome' : 'captcha';
        return { kind };
      }
    }
    const widget = document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-hcaptcha-widget-id], .frc-captcha');
    if (widget && visible(widget) && widget.getBoundingClientRect().height > 30) return { kind: 'widget' };
    const body = N(T(document.body)).slice(0, 20000);
    if (/verify (that )?you are (a )?human|are you a robot|i.?m not a robot|je ne suis pas un robot|verifiez que vous etes humain|access denied|acces refuse/.test(body) && !document.querySelector('form input:not([type=hidden])')) return { kind: 'challenge' };
    return null;
  }

  function access() {
    const login = Array.from(document.querySelectorAll('input[type=password]')).some(visible);
    const otpInput = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]')).some(visible);
    const body = N(T(document.body)).slice(0, 20000);
    const otp = otpInput || /(enter (the )?(verification|security) code|code de (verification|securite)|code a usage unique|one-time (pass)?code|saisissez le code)/.test(body);
    return { login, otp };
  }

  const CONFIRM = [
    /thank(s| you) for (applying|your application|submitting)/,
    /application (has been |was )?(successfully )?(submitted|received|sent)/,
    /we('ve| have) received your application/,
    /your application (has been|was|is) (successfully )?(submitted|received|sent|complete)/,
    /merci (pour|de) votre candidature/,
    /votre candidature (a bien ete|a ete|est bien) (envoyee|transmise|recue|enregistree|prise en compte)/,
    /candidature (bien )?(envoyee|transmise|enregistree)/,
    /vielen dank fur ihre bewerbung/,
    /ihre bewerbung (wurde|ist) (erfolgreich )?(eingegangen|ubermittelt|gesendet|versendet)/,
    /gracias por (tu|su) (solicitud|candidatura|postulacion)/,
    /hemos recibido (tu|su) (solicitud|candidatura)/,
  ];

  function confirmation() {
    const text = N(T(document.body)).slice(0, 40000);
    for (const re of CONFIRM) {
      const m = re.exec(text);
      if (m) return { text: text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 160), url: location.href };
    }
    return null;
  }

  function errors() {
    const out = [];
    const seen = new Set();
    const push = (key, message) => {
      const m = String(message || '').trim().slice(0, 240);
      if (!m || seen.has(`${key}|${m}`)) return;
      seen.add(`${key}|${m}`);
      out.push({ key, message: m });
    };
    document.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      if (!visible(el) && !shownChoice(el)) return;
      const d = el.getAttribute('aria-describedby');
      push(keyOf(el), (d && byIds(d)) || el.validationMessage || 'Champ invalide');
    });
    document.querySelectorAll('.error, .errors, .field-error, .invalid-feedback, .error-message, .form-error, [role=alert]').forEach((el) => {
      if (visible(el) && T(el) && T(el).length < 240) push(null, T(el));
    });
    return out.slice(0, 20);
  }

  function setNative(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /** Remplissage dans la page (extension). Le pilote Playwright utilise ses propres saisies, plus réalistes. */
  function fill(key, value) {
    const el = document.querySelector(`[data-ja-key="${key}"]`);
    if (!el) return { ok: false, reason: 'absent' };
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'radio' || (type === 'checkbox' && Array.isArray(value))) {
      const name = el.name;
      const items = name ? Array.from(document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`)) : [el];
      const wanted = Array.isArray(value) ? value : [value];
      for (const it of items) {
        const id = it.value && it.value !== 'on' ? it.value : it.getAttribute('data-ja-key');
        const want = wanted.includes(id);
        if (it.checked !== want && (want || type === 'checkbox')) it.click();
      }
      return { ok: items.filter((it) => it.checked).length === wanted.length };
    }
    if (type === 'checkbox') {
      if (el.checked !== Boolean(value)) el.click();
      return { ok: el.checked === Boolean(value) };
    }
    if (el.tagName === 'SELECT') {
      const wanted = Array.isArray(value) ? value : [value];
      for (const o of Array.from(el.options)) o.selected = wanted.includes(o.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: wanted.every((w) => Array.from(el.selectedOptions).some((o) => o.value === w)) };
    }
    setNative(el, String(value));
    return { ok: el.value === String(value) };
  }

  /** Valeur actuelle d'un champ (contrôle après remplissage). */
  function valueOf(key) {
    const el = document.querySelector(`[data-ja-key="${key}"]`);
    if (!el) return null;
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      const items = el.name ? Array.from(document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)) : [el];
      if (type === 'checkbox' && items.length === 1) return el.checked;
      return items.filter((x) => x.checked).map((x) => (x.value && x.value !== 'on' ? x.value : x.getAttribute('data-ja-key')));
    }
    if (type === 'file') return Array.from(el.files || []).map((f) => f.name);
    if (el.tagName === 'SELECT') return el.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : el.value;
    return el.value;
  }

  function scan() {
    return { url: location.href, title: document.title, fields: scanFields(), buttons: buttons(), captcha: captcha(), access: access(), errors: errors(), confirmation: confirmation() };
  }

  window.__ja = { version: 2, scan, fill, valueOf, captcha, access, confirmation, errors, buttons, keyOf };
})();
