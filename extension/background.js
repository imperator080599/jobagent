// JobAgent — service d'arrière-plan : seul point de contact avec votre serveur JobAgent.
// Le jeton (portée « apply », révocable dans JobAgent) reste dans le stockage local du navigateur.
async function settings() {
  const { server = '', token = '' } = await chrome.storage.local.get(['server', 'token']);
  return { server: server.replace(/\/+$/, ''), token };
}

async function call(path, init = {}) {
  const { server, token } = await settings();
  if (!server || !token) return { error: 'not_configured' };
  const res = await fetch(`${server}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  if (path.startsWith('/apply/extension/file/')) {
    if (!res.ok) return { error: `http_${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { name: decodeURIComponent(res.headers.get('x-filename') || 'document.pdf'), mime: res.headers.get('content-type') || 'application/pdf', base64: btoa(bin) };
  }
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data?.error?.message || `http_${res.status}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'lookup') return reply(await call('/apply/extension/lookup', { method: 'POST', body: JSON.stringify({ url: msg.url }) }));
      if (msg.type === 'resolve') return reply(await call('/apply/extension/resolve', { method: 'POST', body: JSON.stringify({ url: msg.url, jobId: msg.jobId, fields: msg.fields }) }));
      if (msg.type === 'file') return reply(await call(`/apply/extension/file/${encodeURIComponent(msg.jobId)}/${encodeURIComponent(msg.fileId)}`));
      if (msg.type === 'confirm') return reply(await call('/apply/extension/confirm', { method: 'POST', body: JSON.stringify({ jobId: msg.jobId, url: msg.url, text: msg.text }) }));
      if (msg.type === 'ping') return reply(await call('/me'));
      reply({ error: 'unknown_message' });
    } catch (err) {
      reply({ error: String((err && err.message) || err) });
    }
  })();
  return true;
});
