# JobAgent

Assistant personnel de recherche d'emploi et de candidature. Il cherche les offres, les
sélectionne, les analyse avec **votre** prompt ATS, prépare un CV et une lettre dans **vos**
templates, suit vos candidatures et les réponses reçues — et vous demande votre avis au seul
endroit prévu pour cela : le centre de validation.

Trois principes tiennent tout le reste :

- **Votre CV master est la seule source de vérité.** Aucun agent n'invente une expérience, un
  chiffre, une compétence ou une date. Chaque reformulation est contrôlée par du code, puis par
  un second modèle ; ce qui n'est pas étayé est refusé et le texte d'origine conservé.
- **Rien ne part sans vous.** Une candidature n'est « envoyée » que lorsque vous l'avez déclarée,
  « confirmée » qu'avec un accusé de réception. Aucun email n'est envoyé : au mieux un brouillon.
- **Aucun contournement.** Les sources sont lues par leurs accès officiels ; un refus d'accès,
  un CAPTCHA ou un robots.txt sont respectés. LinkedIn et Indeed ne sont jamais lus automatiquement.

## Démarrage rapide (poste de travail)

Prérequis : Node.js 22 ou plus. Pour produire les PDF : LibreOffice et poppler
(`libreoffice-writer`, `poppler-utils`), plus les polices `fonts-crosextra-carlito`,
`fonts-crosextra-caladea` et `fonts-liberation2` (équivalents métriques de Calibri, Cambria, Arial).

```bash
npm install
```

```bash
npm run build
```

```bash
LLM_PROVIDER=mock npm start
```

Ouvrez <http://localhost:4000>, créez le compte propriétaire, puis suivez la mise en route
(CV master, clé d'API, prompt ATS, informations de candidature).

- Sans `DATABASE_URL`, une base Postgres embarquée est créée dans `./data`.
- `LLM_PROVIDER=mock` simule l'IA (démonstration, sans coût). Retirez-le et saisissez votre clé
  Anthropic dans **Paramètres → IA et budget** pour un usage réel.
- Développement avec rechargement à chaud : `npm run dev` (API sur 4000, interface sur 5173).

## Parcours d'une offre

1. **Collecte** — sources automatiques (sites carrières Greenhouse, Lever, Ashby, SmartRecruiters ;
   France Travail ; Adzuna ; flux RSS), alertes reçues par email, ou ajout manuel (adresse ou texte collé).
2. **Doublons** — une offre diffusée sur plusieurs sites ne donne qu'une fiche ; une candidature
   déjà partie est signalée quelle que soit la source.
3. **Sélection** — règles explicites (contrat, pays, mots exclus), puis deux notes distinctes :
   *pertinence* (intérêt pour votre carrière) et *adéquation* (profil face aux exigences).
4. **Analyse ATS** — votre prompt, exécuté tel quel ; le rapport intégral est conservé.
5. **Votre avis** — décision, réponses aux questions de l'agent (jamais reposées), consignes.
6. **Documents** — CV personnalisé et lettre, rendus dans vos templates, contrôlés sur le PDF final.
7. **Candidature** — contrôle du dossier, validation, envoi par vos soins, déclaration d'envoi.
8. **Suivi** — réponses lues dans Gmail (si connecté), relances préparées, entretiens.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | Développement (API + interface, rechargement à chaud) |
| `npm run build` | Construit l'interface dans `dist/` |
| `npm start` | Démarre l'application (API, interface, planificateur, worker) |
| `npm test` | Tests unitaires et d'intégration (base Postgres embarquée, IA simulée) |
| `TEST_DATABASE_URL=postgres://… npm test` | Les mêmes tests sur un vrai serveur Postgres (une base temporaire par fichier de test) |
| `npm run typecheck` | Vérification des types (serveur et interface) |
| `npm run db:generate` | Génère une migration après modification du schéma |
| `npm run db:migrate` | Applique les migrations |
| `npm run cli -- export --email … --out fichier.json` | Exporte les données d'un compte |

## Configuration

Tout ce qui pilote le comportement se règle dans l'interface (Paramètres, Recherche, Profil).
Les variables d'environnement ne servent qu'au démarrage : voir [`.env.example`](.env.example).
Les clés d'API et jetons se saisissent dans l'interface ; ils sont chiffrés en base et ne sont
jamais réaffichés.

## Documentation

- [Architecture](docs/architecture.md) — composants, agents, données, sécurité.
- [Intégrations externes](docs/integrations.md) — IA, sources d'offres, Gmail, LinkedIn, notifications.
- [Déploiement](docs/deploiement.md) — mise en ligne pour un fonctionnement ordinateur éteint.
- [Sauvegarde et restauration](docs/sauvegarde-restauration.md).
- [État du projet, coûts et limites](docs/etat-et-limites.md) — ce qui est testé, ce qui ne l'est pas, ce qui reste à faire.

## Données personnelles

Ce dépôt ne contient aucune donnée personnelle. Le dossier `private/` (ignoré par git) sert à
charger vos propres documents dans une instance locale ; il ne doit jamais être versé au dépôt.
