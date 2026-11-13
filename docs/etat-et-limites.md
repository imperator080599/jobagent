# État du projet, coûts et limites

Ce document dit ce qui fonctionne, comment cela a été vérifié, ce qui ne l'a pas été, et ce
qui n'est pas fait. Il est tenu à jour à chaque livraison.

## Ce qui est en place

| Domaine | Fonctions |
|---|---|
| Socle | Comptes cloisonnés, mots de passe et sessions, double authentification, jetons d'API, secrets chiffrés, file de tâches, planificateur, journal d'activité |
| Profil | Import du CV (PDF, Word, texte), CV master versionné, informations validées, réponses standards, prompt ATS versionné et jamais réécrit, comparaison LinkedIn par voies officielles |
| Documents | Templates Word de CV et de lettre, génération Word et PDF, contrôle du rendu sur le PDF final, versions conservées et rattachées aux offres |
| Recherche | Critères et synonymes, sept connecteurs, alertes email, ajout manuel, doublons, historique et couverture réelle, offres retirées, santé des sources |
| Analyse | Deux notes distinctes et priorité, analyse ATS avec le prompt de l'utilisateur, boucle de feedback à trois portées, questions jamais reposées |
| Candidature | CV personnalisé contrôlé, lettre, contrôle du dossier, validation, envoi déclaré, interdiction de candidater deux fois |
| Suivi | Gmail par OAuth (lecture et rédaction séparées), classement et rattachement des emails, relances, entretiens détectés, brouillons |
| Pilotage | Centre de validation unique, tableau de bord, analytique, notifications, résumé quotidien, budget IA |
| Données | Export complet, effacement, sauvegarde et restauration |

## Comment cela a été vérifié

**Tests automatisés — 187 tests, tous verts**, sur la base embarquée et sur un serveur
PostgreSQL 16 (pilote de production). Ils couvrent notamment : authentification et protections,
file de tâches, import et versions du CV, prompt ATS restitué caractère pour caractère, doublons
et « déjà candidaté », lecture de pages et refus des adresses internes, connecteurs sur réponses
enregistrées, couverture partielle et offres retirées, refus d'accès non contourné, garde-fous de
véracité du CV et de la lettre, parcours complet d'une candidature, connexion OAuth, classement et
rattachement des emails, relances, notifications, export et effacement.

**Navigateur réel** (Chromium piloté, IA simulée) : création du compte, ajout d'une offre, analyse,
centre de validation, validation des documents, déclaration d'envoi, page de recherche ; sur
écran d'ordinateur et de téléphone ; aucune erreur dans la console.

**Modèle réel** (Claude, sur un CV et un prompt ATS réels, dans une instance locale privée) :
import du CV, sélection, analyse ATS, personnalisation, contrôle de véracité, lettre, rendu dans
les templates. Cette exécution a révélé six défauts, tous corrigés et couverts depuis par des
tests : astérisques résiduels dans le texte transmis au modèle, titre de rubrique ajouté à tort,
lecture trop stricte du tableau de notes, note « prévue après optimisation » prise pour la note
attribuée, document de travail non reconstruit après une évolution du générateur, débordement
d'une page. Résultat observé : cinq reformulations proposées par le modèle ont été refusées par
les contrôles (ajouts non étayés par le CV), trois acceptées ; la lettre tenait sur une page
sans affirmation non étayée.

**Mode production** : démarrage sur PostgreSQL 16, création du compte avec jeton, parcours
complet, sauvegarde puis restauration dans une base neuve et redémarrage dessus. Cette
vérification a révélé un défaut du pilote de production (dates mal transmises), corrigé.

**API réelles des plateformes** : la forme des réponses de Greenhouse, Lever, Ashby et
SmartRecruiters a été relevée sur les services réels (novembre 2026) et les connecteurs écrits
d'après elle.

## Ce qui n'a pas été vérifié en conditions réelles

À vérifier lors de la mise en service ; rien de ceci n'est présenté comme acquis.

- **Appel direct à l'API Anthropic avec une clé** : les agents ont été exercés avec le modèle
  réel par une autre voie (ligne de commande locale) et avec la simulation. Le chemin « clé d'API »
  — dont l'envoi du PDF du CV au modèle — reste à constater à la première analyse.
- **Connecteurs en production** : l'environnement de développement n'autorise pas les appels
  sortants vers ces services. France Travail et Adzuna, qui exigent des identifiants, ont été
  écrits d'après leur documentation et testés sur des réponses enregistrées seulement.
- **Gmail** : testé contre un service Google simulé, jamais contre le vrai.
- **Lecture des alertes email** : écrite sans échantillon réel d'alerte ; à ajuster sur les vôtres.
- **Notifications** : envois vérifiés sur un récepteur simulé.
- **Image Docker et HTTPS** : non construits (pas de moteur Docker disponible).
- **Durée** : aucun fonctionnement continu sur plusieurs jours n'a été observé.

## Ce qui n'est pas fait

- **Candidature automatisée** (remplissage et soumission de formulaires par un navigateur
  piloté) : non réalisée. Le mode « autonome » enchaîne seul jusqu'aux documents prêts ; le dépôt
  de la candidature reste un geste de l'utilisateur, suivi d'une déclaration d'envoi. La banque de
  réponses standards existe mais ne remplit encore aucun formulaire.
- **Préparation d'entretien** et **réseau** (contacts, recommandations) : les données sont
  prévues, aucun agent ne les exploite.
- **Autres sources** : Workday, Workable, Recruitee, Personio, Jooble, offres V.I.E — non couvertes
  automatiquement. LinkedIn, Indeed et les sites protégés ne le seront pas (conditions d'utilisation).
- **Traduction du CV** : un CV personnalisé est rédigé dans la langue de son master. Postuler dans
  une autre langue suppose d'importer un master dans cette langue.
- **Templates de CV à zones vides** : le template de CV doit être votre CV au format Word. Un
  template générique à remplir n'est pas pris en charge.
- **Ajout d'une expérience dans un template Word importé** : non automatisé ; l'application
  demande alors la version Word à jour.
- **Banc d'évaluation** des agents (jeu d'offres de référence noté) : non construit ; la qualité
  repose sur les garde-fous testés et sur la relecture de l'utilisateur.
- **Tests de bout en bout rejouables** dans le dépôt : les parcours navigateur ont été exécutés
  par des scripts de vérification, non conservés comme suite de tests.
- **Notification par email**, **envoi d'emails** : volontairement absents (brouillons seulement).

## Limites connues

- Faute de fichier Word, le template de CV est un document reconstitué à partir du PDF : proche
  de l'original et sur la même pagination, mais pas identique. Importer le fichier Word d'origine
  lève cette limite.
- Les contrôles de véracité sont volontairement stricts : ils refusent parfois une reformulation
  légitime (un terme écrit autrement que dans le CV, par exemple). Le texte d'origine est alors
  conservé ; confirmer une compétence dans le centre de validation lève le refus.
- Un CV en allemand verrait trop de refus (les noms communs y portent une majuscule).
- Sans IA, l'import du CV fonctionne par règles et ne restitue pas le gras d'origine.
- Les agrégateurs ne fournissent qu'un extrait des annonces : le texte complet est récupéré sur
  le site d'origine quand il l'autorise, demandé à l'utilisateur sinon.
- L'analyse ATS d'un CV non modifié puis de sa version personnalisée peut donner la même note :
  quand les mots-clés manquants correspondent à une expérience absente du CV, rien n'est ajouté.

## Coûts

Coûts de l'IA relevés sur une exécution réelle (modèle principal Claude Opus 5.5, modèle
économique Claude Haiku 5.5), calculés d'après la grille tarifaire configurée dans l'application —
à confirmer sur votre facture :

| Opération | Coût estimé | Durée |
|---|---|---|
| Sélection d'une offre (deux notes) | 0,001 $ | 7 s |
| Analyse ATS (rapport complet, environ 15 000 jetons) | 0,34 $ | 2 min 20 |
| Lecture du rapport | 0,002 $ | 10 s |
| CV personnalisé | 0,18 à 0,20 $ | 1 min 10 |
| Contrôle de véracité du CV | 0,001 $ | 7 s |
| Lettre et son contrôle | 0,10 $ | 35 s |
| Import du CV master (une fois) | 0,08 $ | 20 s |

Soit environ **0,34 $ par offre analysée** et **1 $ par candidature préparée** (deux analyses ATS,
un CV, une lettre). L'analyse ATS pèse l'essentiel : le plafond quotidien d'analyses (12 par
défaut) et le seuil de pertinence règlent directement la dépense. Budget par défaut : 4 $ par jour,
40 $ par mois ; au-delà, les tâches attendent.

Hébergement : un petit serveur virtuel toujours allumé, avec sa base Postgres dans le même
`docker compose`. Le prix dépend de l'hébergeur choisi ; aucun n'a été retenu ni testé ici.

## Ce qu'il reste à faire de votre côté

1. Choisir un hébergeur, déployer (voir [Déploiement](deploiement.md)) et activer la double authentification.
2. Saisir votre clé d'API Anthropic (Paramètres → IA et budget).
3. Relire et valider votre CV master importé ; coller votre prompt ATS.
4. Importer votre CV au format Word pour un template fidèle, et votre modèle de lettre.
5. Définir vos recherches (Recherche → Critères) et vos sources ; pour France Travail et Adzuna, créer vos identifiants gratuits.
6. Compléter vos informations de candidature (mobilité, disponibilité, préavis…).
7. Pour le suivi par email : créer un identifiant OAuth dans Google Cloud et connecter Gmail.
8. Mettre en place la sauvegarde quotidienne et tester une restauration.
