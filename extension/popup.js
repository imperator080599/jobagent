// Fenêtre de l'extension : état de la page courante ; « Remplir cette page » pour les sites carrière
// hors liste (autorisation ponctuelle de l'onglet actif, jamais d'accès permanent).
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = document.getElementById('status');
  const info = await chrome.runtime.sendMessage({ type: 'lookup', url: tab.url });
  if (!info || info.error) return (status.textContent = info && info.error === 'not_configured' ? 'Configurez votre JobAgent dans les réglages.' : 'JobAgent injoignable.');
  if (info.policy.autonomy === 'manual') return (status.textContent = `${info.policy.name} n'autorise pas le remplissage automatique : utilisez les réponses préparées dans JobAgent.`);
  if (!info.match) return (status.textContent = 'Aucune candidature préparée pour cette page.');
  status.textContent = `Candidature préparée détectée (${info.policy.name}).`;
  const btn = document.getElementById('fill');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inpage.js', 'content.js'] });
    window.close();
  });
})();
