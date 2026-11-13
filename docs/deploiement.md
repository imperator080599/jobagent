# Déploiement

> **État au moment de la livraison : l'application n'est pas déployée.** Ce document décrit la
> procédure. Ce qui a été vérifié : le démarrage en mode production sur un serveur PostgreSQL 16
> (migrations, création du compte avec jeton, parcours complet d'une candidature), l'ensemble des
> tests automatisés sur ce même serveur, et les scripts de sauvegarde et de restauration.
> Ce qui ne l'a pas été : la construction de l'image Docker (pas de moteur Docker disponible dans
> l'environnement de développement) et le service HTTPS. Prévoyez une première construction attentive.

Pour fonctionner ordinateur éteint, l'application a besoin d'une machine toujours allumée :
un petit serveur virtuel suffit (2 vCPU, 2 à 4 Go de mémoire, 20 Go de disque). Une plateforme
purement « serverless » ne convient pas telle quelle : le rendu des documents repose sur
LibreOffice et le travail de fond sur un processus persistant.

## 1. Préparer la machine

- Un serveur Linux avec Docker et Docker Compose.
- Un nom de domaine pointant vers lui (pour le HTTPS automatique), ports 80 et 443 ouverts.

## 2. Récupérer le code et configurer

```bash
git clone https://github.com/imperator080599/jobagent.git
```

```bash
cd jobagent && cp .env.example .env
```

Renseignez dans `.env` :

| Variable | Valeur |
|---|---|
| `POSTGRES_PASSWORD` | mot de passe de la base (long, aléatoire) |
| `APP_SECRET` | `openssl rand -base64 48` — **à conserver précieusement** : il chiffre vos secrets |
| `APP_URL` | adresse publique, par exemple `https://emploi.exemple.fr` |
| `SETUP_TOKEN` | jeton aléatoire, exigé pour créer le premier compte |
| `DOMAIN` | le nom de domaine (profil HTTPS) |
| `ANTHROPIC_API_KEY` | facultatif : la clé peut être saisie dans l'interface |

Ne versez jamais `.env` dans un dépôt.

## 3. Démarrer

```bash
docker compose --profile https up -d --build
```

- La base est créée et les migrations appliquées au premier démarrage.
- Ouvrez `APP_URL`, créez le compte propriétaire avec le `SETUP_TOKEN`, activez la double
  authentification (Paramètres → Sécurité), puis suivez la mise en route.
- Le planificateur et le worker tournent dans le même conteneur : recherche périodique, lecture
  de la messagerie, relances et résumé quotidien fonctionnent sans autre réglage.

Vérifications :

```bash
docker compose ps
```

```bash
docker compose logs -f app
```

```bash
curl -s https://emploi.exemple.fr/api/health
```

## 4. Mettre à jour

```bash
git pull && docker compose --profile https up -d --build
```

Les migrations sont appliquées au démarrage. Faites une sauvegarde avant chaque mise à jour.

## Variantes

- **Base managée** (Supabase, Neon…) : retirez le service `db` et donnez son adresse dans
  `DATABASE_URL`. Avec un pooler en mode transaction, utilisez le port du pooler.
- **Sans Docker** : Node.js 22, LibreOffice, poppler et les polices indiqués dans le README ;
  `npm ci && npm run build`, puis `NODE_ENV=production npm start` derrière un proxy HTTPS.
- **Plateforme qui endort les conteneurs** : renseignez `CRON_SECRET` et faites appeler
  `POST /api/cron/tick` (en-tête `Authorization: Bearer <CRON_SECRET>`) toutes les cinq à dix
  minutes par un planificateur externe.
- **Poste de travail seul** : `npm start` suffit, mais rien ne tourne ordinateur éteint.

## Sécurité d'une instance publique

- HTTPS obligatoire (le profil `https` s'en charge). Le port 4000 n'est lié qu'à la machine.
- `SETUP_TOKEN` empêche qu'un tiers crée le premier compte ; une fois le compte créé, les
  autres utilisateurs sont ajoutés par le propriétaire.
- Activez la double authentification.
- Gardez `APP_SECRET` hors de la machine (gestionnaire de mots de passe) : sans lui, une
  sauvegarde restaurée ne permet plus de lire les secrets chiffrés (il faudra les ressaisir).
- Rendez le dépôt privé si vous y ajoutez quoi que ce soit de personnel.
