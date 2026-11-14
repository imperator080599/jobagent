const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['server', 'token']).then(({ server = '', token = '' }) => {
  $('server').value = server;
  $('token').value = token;
});
$('save').addEventListener('click', async () => {
  const server = $('server').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  try {
    const origin = new URL(server).origin;
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return ($('status').textContent = "Autorisation refusée : l'extension ne peut pas joindre votre serveur.");
  } catch {
    return ($('status').textContent = 'Adresse invalide.');
  }
  await chrome.storage.local.set({ server, token });
  const me = await chrome.runtime.sendMessage({ type: 'ping' });
  $('status').textContent = me && me.user ? `Connecté : ${me.user.email}` : `Échec de la connexion (${(me && me.error) || 'inconnu'}).`;
});
