# Architecture

## Vue d'ensemble

Une seule application Node.js (TypeScript) expose l'API, sert l'interface et fait tourner le
travail de fond. Une base Postgres porte tout l'état : aucun état n'est gardé en mémoire, ce qui
permet de redémarrer à tout moment sans rien perdre ni rien rejouer.

```
Navigateur (React) ──HTTPS──▶ API Hono ──▶ Postgres
                                 │            ▲
                                 │            │ file de tâches, planification, documents
                                 ▼            │
                     Planificateur ──▶ Worker ─┴──▶ Agents (IA) ──▶ API Anthropic
                                          │
                                          ├──▶ Connecteurs de sources (API publiques, flux)
                                          ├──▶ Gmail (OAuth)
                                          └──▶ LibreOffice (rendu PDF) + contrôle du rendu
```

| Dossier | Contenu |
|---|---|
| `src/api` | Routes HTTP, authentification, protections (CSRF, en-têtes, portées des jetons) |
| `src/auth` | Mots de passe (scrypt), sessions, double authentification (TOTP), jetons d'API |
| `src/core` | File de tâches, centre de validation, journal, secrets chiffrés, réglages, export |
| `src/db` | Schéma (Drizzle) et accès Postgres ; migrations SQL dans `drizzle/` |
| `src/profile` | CV master, informations validées, réponses standards, prompt ATS, LinkedIn |
| `src/docs` | Templates Word, génération des documents, conversion PDF, contrôle qualité |
| `src/search` | Normalisation, doublons, connecteurs, moteur de collecte, synonymes |
| `src/pipeline` | Qualification, agent ATS, boucle de feedback, planificateur, worker |
| `src/writer` | Agents de personnalisation du CV et de rédaction de la lettre |
| `src/apply` | Contrôle du dossier, validation, enregistrement de l'envoi |
| `src/tracker` | Statuts, Gmail, classement des emails, relances |
| `src/notify` | Notifications et résumé quotidien |
| `src/llm` | Accès aux modèles (Anthropic, simulation, CLI locale), coûts, budget, défense contre l'injection |
| `src/shared` | Types et règles partagés avec l'interface (statuts, réglages, modèle de CV) |
| `web/` | Interface React (Vite, Tailwind, TanStack Query) |

## Qui fait quoi : code, IA, humain

Le système n'emploie un modèle que là où un jugement de langage est nécessaire. Tout ce qui
engage (identifier une offre, décider d'un doublon, changer un statut, écrire en base, appeler
une source) est du code déterministe.

| Tâche | Réalisée par |
|---|---|
| Normalisation d'une offre, détection des doublons, expiration | Code |
| Filtres explicites (contrat, pays, mots exclus, entreprise exclue) | Code |
| Notes de pertinence et d'adéquation | Modèle économique |
| Analyse ATS | Modèle principal, avec le prompt de l'utilisateur, sans réécriture |
| Lecture de la note du rapport | Code, recoupé par le modèle économique et par la somme des items |
| Propositions de reformulation du CV | Modèle principal |
| Acceptation d'une reformulation | Code (chiffres, sigles, noms propres, mots-clés, compétences infirmées) puis modèle vérificateur |
| Rédaction de la lettre | Modèle principal ; en-tête, date, formules : code |
| Rendu Word et PDF, contrôle du rendu | Code (copie du template, LibreOffice, mesure du PDF) |
| Classement d'un email | Règles, puis modèle économique |
| Effet d'un email sur une candidature | Code, uniquement si le rattachement est certain |
| Décision de postuler, validation des documents, envoi | Utilisateur |

Les agents ne disposent d'aucun outil : un modèle ne peut que rendre un texte ou une structure,
que le code vérifie avant usage. Les contenus externes (offres, pages, emails) sont encadrés comme
données non fiables ; une annonce contenant un texte adressé à une IA est signalée et aucune
automatisation ne s'applique à elle.

## Agents

| Agent | Finalité | Modèle |
|---|---|---|
| Qualification (`job.qualify`) | Deux notes, synthèse, points bloquants | économique |
| ATS (`ats.analyze`, `ats.extract`) | Exécution du prompt de l'utilisateur ; extraction de la synthèse | principal ; économique |
| CV (`cv.tailor`, `cv.verify`) | Modifications ciblées du master ; chasse aux faits ajoutés | principal ; économique |
| Lettre (`letter.write`, `letter.verify`) | Rédaction selon le template ; contrôle de véracité | principal ; économique |
| Email (`mail.classify`, `mail.reply`, `mail.followup`) | Classement ; brouillons | économique |
| Import (`cv.structure`, `job.extract`) | Structuration du CV importé ; champs d'une offre collée | principal ; économique |

Chaque appel est journalisé (finalité, modèle, jetons, coût estimé) et compté dans le budget
quotidien et mensuel de l'utilisateur ; le budget atteint, les tâches attendent sans échouer.

## Données

Toutes les tables métier portent un `user_id` : chaque compte dispose d'un espace cloisonné.

- **Profil** : `cv_versions` (master, versions par candidature, traçabilité des modifications),
  `templates`, `profile_facts` (informations validées, avec leur source), `qa_answers`,
  `ats_prompts` (versions, jamais réécrites), `feedback`.
- **Recherche** : `search_profiles`, `companies`, `sources`, `source_runs` (historique et
  couverture), `jobs`, `job_sightings` (où et quand une offre a été vue), `stage_history`.
- **Candidature** : `ats_analyses` (rapport intégral + synthèse), `letters`, `applications`
  (une seule par offre, contrainte en base), `application_attempts`.
- **Suivi** : `emails` (uniquement ceux liés aux candidatures), `drafts`, `interviews`, `contacts`.
- **Fonctionnement** : `tasks` (file), `schedule_state`, `action_items` (centre de validation),
  `activity_log`, `llm_calls`, `notifications`, `files` (documents, stockés en base).

### File de tâches

- Une seule tâche active par clé d'idempotence : une reprise ne crée jamais de doublon.
- Prise atomique (`FOR UPDATE SKIP LOCKED`) ; réessais à délai croissant ; reprise des tâches
  orphelines après un arrêt brutal.
- Une tâche qui attend une action de l'utilisateur (clé absente, template manquant, texte
  d'annonce incomplet) passe en « attente » avec son motif et repart d'elle-même une fois la
  cause levée.
- Chaque tâche vérifie le statut de l'offre avant d'agir : rejouée, elle ne fait rien.

### Statuts d'une offre

`new → to_analyze → analyzed → awaiting_feedback → cv_in_progress → letter_in_progress →
ready_to_apply → sent → confirmed → interview_hr / interview_tech → offer`, plus `rejected`,
`no_response`, `follow_up_needed`, `abandoned`, `filtered`, `expired`. Les transitions autorisées
sont listées dans `src/shared/stages.ts` ; tout le reste est refusé, si bien qu'une opération
rejouée ne peut pas faire reculer une candidature envoyée.

## Documents

Les templates sont des documents Word. Un CV personnalisé est une **copie du template** dans
laquelle seuls les paragraphes modifiés sont réécrits (mise en forme d'origine conservée) ; rien
n'est reconstruit à partir de zéro. Faute de fichier Word, un document de travail est constitué
à partir du CV importé, ajusté pour tenir sur la même pagination, et signalé comme tel.

Chaque document produit est converti en PDF puis **rouvert et mesuré** : pagination, marges,
contenu complet, caractères, zones non remplies, astérisques résiduels, polices, lisibilité,
écart avec le template. Un CV qui déborde revient au texte d'origine pour les éléments
allongés ; aucune information n'est supprimée pour gagner de la place.

## Sécurité

- Mots de passe : scrypt ; sessions en cookie `HttpOnly`, `SameSite=Lax`, stockées hachées ;
  double authentification TOTP et codes de secours ; limitation des tentatives.
- Requêtes modifiantes : contrôle d'origine et en-tête dédié (CSRF) ; en-têtes de sécurité.
- Secrets : AES-256-GCM, clé dérivée de `APP_SECRET` ; l'API ne renvoie qu'un indice masqué.
- Premier compte : `SETUP_TOKEN` exigé en production.
- Requêtes sortantes : identification honnête, robots.txt, refus des adresses internes à chaque
  redirection, délais et tailles bornés, cadence limitée par hôte.
- Données sensibles du profil (nationalité, date de naissance, rémunération) : jamais transmises
  à un modèle pour noter une offre.
- Fichiers servis à leur seul propriétaire, avec une politique de contenu stricte.
