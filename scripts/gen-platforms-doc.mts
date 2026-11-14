// Génère docs/plateformes.md à partir de la matrice du code (source unique de vérité).
import { writeFileSync } from 'node:fs';
import { PLATFORM_POLICIES } from '../src/apply/platforms.js';

const V: Record<string, string> = { allowed: 'permise', not_prohibited: 'non interdite (aucune interdiction trouvée)', restricted: 'restreinte', prohibited: 'interdite', unverified: 'non vérifiée' };
const A: Record<string, string> = { auto: 'Remplissage et envoi automatiques (si vous l’autorisez)', prefill: 'Remplissage automatique, envoi par vous', manual: 'Préparation seulement, candidature faite par vous' };
const esc = (s: string) => s.replace(/\|/g, '\\|');
const rows = Object.values(PLATFORM_POLICIES);
let md = `# Plateformes : ce qui est permis, et la preuve

> Document généré depuis \`src/apply/platforms.ts\` (\`npx tsx scripts/gen-platforms-doc.mts\`). Conditions vérifiées le ${rows[0]!.evidence[0]?.checkedAt ?? '—'} ; elles peuvent évoluer.

Règles : JobAgent ne contourne ni CAPTCHA, ni protection anti-robots, ni restriction d'accès. Le plafond d'automatisation
d'une plateforme n'est jamais dépassé, quel que soit le réglage. Quand l'automatisation est interdite ou impossible, la
meilleure alternative autorisée est utilisée (alertes e-mail, site de l'employeur, préparation complète pour une
candidature manuelle en quelques minutes).

## Synthèse

| Plateforme | Lecture des offres | Alertes e-mail | API de candidature pour candidat | Automatisation du navigateur | Envoi automatique | Plafond retenu |
|---|---|---|---|---|---|---|
`;
for (const p of rows) md += `| ${p.name} | ${esc(p.read.method)} (${V[p.read.verdict]}) | ${p.emailAlerts ? 'oui' : '—'} | ${p.officialApply.available ? 'oui' : 'non'} | ${V[p.browserAutomation]} | ${V[p.autoSubmit]} | ${A[p.autonomy]} |\n`;
md += `\n## Détail et preuves\n`;
for (const p of rows) {
  md += `\n### ${p.name}\n\n- API de candidature : ${esc(p.officialApply.note)}\n`;
  if (p.human.length) md += `- Interventions humaines prévisibles : ${p.human.join(' ; ')}.\n`;
  for (const l of p.limits) md += `- ${l}\n`;
  for (const e of p.evidence) md += `- Preuve (${e.checkedAt}) — « ${e.quote} » — <${e.url}>\n`;
  if (!p.evidence.length) md += `- Aucune clause trouvée sur l'automatisation : ${p.autoSubmit === 'not_prohibited' ? 'envoi automatique possible si vous l’autorisez, arrêt sur tout contrôle anti-robots.' : 'par prudence, l’envoi vous est laissé.'}\n`;
}
writeFileSync(new URL('../docs/plateformes.md', import.meta.url), md);
console.log('docs/plateformes.md', md.length, 'caractères');
