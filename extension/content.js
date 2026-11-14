// JobAgent — remplissage du formulaire ouvert, dans votre navigateur et sous vos yeux.
// Règles : uniquement pour une candidature préparée dans JobAgent ; uniquement les réponses
// validées (rien n'est inventé) ; les documents de CETTE candidature ; jamais de clic sur
// « Envoyer » ; aucun CAPTCHA ni contrôle d'accès n'est touché.
(() => {
  if (window.__jobagentContent) return;
  window.__jobagentContent = true;
  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  const state = { jobId: null, filled: new Set(), missing: new Map(), initialConfirmation: null, recorded: false, busy: false, platform: '' };

  function panel(html, tone = 'info') {
    let el = document.getElementById('jobagent-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'jobagent-panel';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:12px 14px;border-radius:10px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18);color:#0f172a;background:#fff;border:1px solid #cbd5e1';
      document.documentElement.appendChild(el);
    }
    el.style.borderColor = tone === 'success' ? '#10b981' : tone === 'warning' ? '#f59e0b' : '#6366f1';
    el.innerHTML = `<strong>JobAgent</strong><div style="margin-top:4px">${html}</div>`;
  }
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  async function attach(key, fileId) {
    const doc = await send({ type: 'file', jobId: state.jobId, fileId });
    if (!doc || doc.error) return false;
    const bin = atob(doc.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const input = document.querySelector(`[data-ja-key="${key}"]`);
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], doc.name, { type: doc.mime }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length === 1 && input.files[0].name === doc.name;
  }

  async function chooseOption(key, text) {
    const input = document.querySelector(`[data-ja-key="${key}"]`);
    if (!input) return false;
    input.focus();
    input.click();
    window.__ja.fill(key, text);
    for (let i = 0; i < 20; i++) {
      const opt = Array.from(document.querySelectorAll('[role=option]')).find((o) => o.textContent.trim().toLowerCase().includes(String(text).toLowerCase()));
      if (opt) {
        opt.click();
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function fillPage() {
    if (state.busy || !state.jobId) return;
    state.busy = true;
    try {
      const scan = window.__ja.scan();
      const fresh = scan.fields.filter((f) => !state.filled.has(f.key));
      if (!fresh.length) return;
      const res = await send({ type: 'resolve', url: location.href, jobId: state.jobId, fields: fresh });
      if (!res || res.error || res.refused) {
        panel(esc(res?.reason || res?.error || 'Remplissage indisponible.'), 'warning');
        return;
      }
      for (const r of res.fields) {
        const f = fresh.find((x) => x.key === r.key);
        if (!f) continue;
        if (r.status !== 'ready') {
          if (r.required && (r.status === 'missing' || r.status === 'needs_human')) state.missing.set(r.key, r.label);
          continue;
        }
        let ok = false;
        if (f.type === 'file') ok = await attach(f.key, r.value);
        else if (f.tag === 'combobox') ok = await chooseOption(f.key, r.display || r.value);
        else ok = window.__ja.fill(f.key, r.value).ok;
        if (ok) {
          state.filled.add(f.key);
          state.missing.delete(f.key);
        } else state.missing.set(f.key, r.label);
      }
      const missing = Array.from(state.missing.values());
      const captcha = window.__ja.captcha();
      panel(
        `${state.filled.size} champ(s) rempli(s)${missing.length ? ` · <b>${missing.length} à compléter</b> : ${missing.map(esc).join(', ')}` : ''}.` +
          `${captcha ? '<br>Contrôle anti-robots présent : résolvez-le vous-même.' : ''}<br>Vérifiez, puis envoyez vous-même la candidature.`,
        missing.length || captcha ? 'warning' : 'success',
      );
    } finally {
      state.busy = false;
    }
  }

  // Envoi par l'utilisateur : la page de confirmation est souvent une nouvelle page. On mémorise, pour cet
  // onglet et ce site seulement, qu'un envoi vient d'être fait pour cette candidature.
  const PENDING = 'jobagent:pending';
  function markPending() {
    if (!state.jobId) return;
    try {
      sessionStorage.setItem(PENDING, JSON.stringify({ jobId: state.jobId, at: Date.now() }));
    } catch {
      /* stockage indisponible : la confirmation sera déclarée dans JobAgent */
    }
  }
  function pending() {
    try {
      const p = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
      return p && Date.now() - p.at < 15 * 60_000 ? p : null;
    } catch {
      return null;
    }
  }
  document.addEventListener('submit', markPending, true);
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target && e.target.closest && e.target.closest('button, input[type=submit], [role=button]');
      if (b && window.__ja && window.__ja.buttons().submit === b.getAttribute('data-ja-key')) markPending();
    },
    true,
  );

  async function watchConfirmation() {
    if (state.recorded || !state.jobId) return;
    const c = window.__ja.confirmation();
    if (c && c.text !== state.initialConfirmation) {
      state.recorded = true;
      try {
        sessionStorage.removeItem(PENDING);
      } catch {
        /* rien */
      }
      const res = await send({ type: 'confirm', jobId: state.jobId, url: c.url, text: c.text });
      panel(res && !res.error ? 'Candidature envoyée : confirmation enregistrée dans JobAgent.' : `Confirmation lue, mais non enregistrée (${esc(res?.error)}). Déclarez l'envoi dans JobAgent.`, res && !res.error ? 'success' : 'warning');
    }
  }

  async function start() {
    if (!window.__ja) return;
    // Page de confirmation affichée juste après votre envoi : elle est rattachée à la candidature.
    const sent = pending();
    if (sent && window.__ja.confirmation()) {
      state.jobId = sent.jobId;
      state.initialConfirmation = null;
      return watchConfirmation();
    }
    const info = await send({ type: 'lookup', url: location.href });
    if (!info || info.error) return;
    state.platform = info.platform;
    if (info.policy?.autonomy === 'manual') return;
    if (!info.match) return;
    state.jobId = info.match.jobId;
    state.initialConfirmation = window.__ja.confirmation()?.text ?? null;
    await fillPage();
    // Parcours en plusieurs étapes : chaque nouvelle étape est remplie dès qu'elle s'affiche.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fillPage();
        watchConfirmation();
      }, 500);
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(watchConfirmation, 2000);
  }

  window.__jobagentStart = start;
  start();
})();
