# État du projet, coûts et limites

Ce document dit ce qui fonctionne, comment cela a été vérifié, ce qui ne l'a pas été, et ce
qui n'est pas fait. Il est tenu à jour à chaque livraison.

## Ce qui est en place

| Domaine | Fonctions |
|---|---|
| Socle | Comptes cloisonnés, mots de passe et sessions, double authentification, jetons d'API limités à leur portée, secrets chiffrés, file de tâches, planificateur, journal d'activité |
| Profil | Import du CV (PDF, Word, texte), CV master versionné, informations validées, réponses standards, prompt ATS versionné, importé octet pour octet et comparable à votre original, comparaison LinkedIn par voies officielles |
| Documents | Templates Word de CV et de lettre, génération Word et PDF, contrôle du rendu sur le PDF final, versions conservées et rattachées aux offres |
| Recherche | Critères et synonymes (français, anglais, espagnol, allemand), douze connecteurs (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Workable, Recruitee, Personio, Breezy, France Travail, Adzuna, flux), alertes e-mail (LinkedIn, Indeed, WTTJ, Apec, HelloWork, Glassdoor, Monster, Cadremploi, JobTeaser, eFinancialCareers, VIE, France Travail), annuaire d'employeurs avec découverte et vérification des sites carrières, doublons, offres retirées, matrice de couverture |
| Analyse | Deux notes distinctes et priorité, analyse ATS avec le prompt de l'utilisateur transmis à l'identique (preuve par empreintes), note attribuée et note projetée séparées, boucle de feedback |
| Candidature | CV personnalisé contrôlé, lettre, contrôle du dossier, moteur de candidature (remplissage, pièces jointes, étapes, envoi, confirmation), règles AUTOPILOT, extension de navigateur, matrice des plateformes avec preuves, interdiction de candidater deux fois |
| Suivi | Gmail par OAuth (lecture et rédaction séparées), classement et rattachement des emails, accusé de réception qui confirme un envoi, relances, entretiens détectés, préparation d'entretien automatique |
| Pilotage | Centre de validation unique (y compris questions de formulaire et interventions), tableau de bord avec bandeau AUTOPILOT, analytique, notifications, résumé quotidien, budget IA |
| Données | Export complet, effacement, sauvegarde et restauration |

## Comment cela a été vérifié

**Tests automatisés — 237 tests, tous verts** (base embarquée ; la suite tourne aussi sur
PostgreSQL 16). En plus des tests antérieurs : intégrité du prompt ATS jusqu'au corps HTTP réellement
produit par le SDK Anthropic ; moteur de candidature sur des formulaires de **démonstration** servis
localement (structures Greenhouse, Lever, Workday en plusieurs étapes, Ashby avec liste personnalisée,
Workable, page de connexion) : remplissage, listes, boutons radio, cases, pièces jointes vérifiées à
l'octet, étapes, champs obligatoires, refus de la page, CAPTCHA, connexion, reprise, interruption
pendant l'envoi, exécutions simultanées, site en panne, offre retirée ; extension (son script réel
exécuté dans la page) ; nouveaux connecteurs, annuaire et découverte, matrice de couverture ; chaîne
complète AUTOPILOT de l'offre à la candidature confirmée ; préparation d'entretien.

**Aucune candidature réelle** n'a été envoyée pour tester : tous les envois ont visé des formulaires
de démonstration locaux.

**Intégrité du prompt ATS en conditions réelles** (instance privée, modèle réel via Claude Code) :
l'entrée réellement reçue par Claude Code, capturée indépendamment, a la même empreinte que le
message enregistré, et en retirant le CV et l'offre on retrouve exactement le prompt de
l'utilisateur (même SHA-256). Voir [Intégrité du prompt ATS](integrite-prompt-ats.md).

**Connecteurs relus en conditions réelles, en lecture seule** (13 novembre 2026) : Greenhouse,
Lever (pagination complète), Ashby, SmartRecruiters, Personio et Breezy répondent et sont lus
correctement. Workable (identifiant d'essai inconnu) et Workday (erreur 521 du site depuis cet
environnement) n'ont pas pu être vérifiés : ils apparaissent « jamais lus avec succès » dans la
couverture tant qu'une première lecture réelle n'a pas réussi.

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

## Ce qui n'a pas été vérifié en conditions réelles

À vérifier lors de la mise en service ; rien de ceci n'est présenté comme acquis.

- **Appel direct à l'API Anthropic avec une clé** : le corps exact de la requête produite par le
  SDK officiel est vérifié par les tests (serveur simulé) ; l'appel réel avec votre clé — dont l'envoi
  du PDF du CV — reste à constater à la première analyse.
- **Envoi réel d'une candidature** : volontairement jamais fait. Le premier envoi réel aura lieu sur
  une offre que vous aurez choisie ; vérifiez sa confirmation dans la fiche de l'offre.
- **Extension dans un vrai profil Chrome** : son code est exécuté et testé dans la page, mais elle n'a
  pas été chargée dans votre navigateur.
- **Workable, Recruitee, Workday** : points d'accès non vérifiés en conditions réelles (voir plus haut).
- **France Travail** : l'API « Offres d'emploi » est actuellement retirée par France Travail ; les offres
  arrivent par vos alertes e-mail.
- **Gmail** : testé contre un service Google simulé, jamais contre le vrai ; lecture des alertes écrite
  sans échantillon réel (à ajuster sur les vôtres).
- **Notifications** : envois vérifiés sur un récepteur simulé.
- **Image Docker (avec Chromium) et HTTPS** : non construits (pas de moteur Docker disponible).
- **Durée** : aucun fonctionnement continu sur plusieurs jours n'a été observé ; rien n'est déployé.

## Ce qui n'est pas fait

- **CAPTCHA en direct depuis le serveur** : quand un contrôle anti-robots apparaît, la reprise se fait
  dans votre navigateur (extension, qui remplit à l'identique) ; il n'y a pas de vue à distance du
  navigateur du serveur.
- **Automatisation sur LinkedIn, Indeed, Welcome to the Jungle** : interdite par leurs conditions ;
  préparation complète et candidature par vous.
- **Lecture directe** d'Apec, HelloWork, Glassdoor, Monster, JobTeaser, eFinancialCareers, VIE :
  aucune API publique ; ces sites sont couverts par vos alertes e-mail. Google pour l'emploi : aucune
  API pour les candidats.
- **Taleo, SuccessFactors, iCIMS** : pas de connecteur de lecture (pages dynamiques à compte) ; offres
  connues par les alertes et les autres sources, candidature assistée par l'extension.
- **Réseau** (contacts, recommandations) : les données sont prévues, aucun agent ne les exploite.
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

Soit environ **0,33 $ par offre analysée** (sélection, analyse ATS, lecture du rapport) et
**0,94 $ par candidature préparée** de bout en bout (analyse, CV personnalisé et sa nouvelle note,
lettre, contrôles) — mesures du 13 novembre 2026 sur l'instance privée. Le remplissage et l'envoi
d'un formulaire n'appellent pas de modèle : seul le temps de calcul compte (de quelques secondes à
une minute par formulaire). L'analyse ATS pèse l'essentiel : le plafond quotidien d'analyses (12 par
défaut) et le seuil de pertinence règlent directement la dépense. Budget par défaut : 4 $ par jour,
40 $ par mois ; au-delà, les tâches attendent.

Hébergement : un petit serveur virtuel toujours allumé, avec sa base Postgres dans le même
`docker compose`. Le prix dépend de l'hébergeur choisi ; aucun n'a été retenu ni testé ici.

## Ce qu'il reste à faire de votre côté

1. Choisir un hébergeur, déployer (voir [Déploiement](deploiement.md)) et activer la double authentification.
2. Saisir votre clé d'API Anthropic (Paramètres → IA et budget).
3. Relire et valider votre CV master importé ; coller votre prompt ATS.
4. Importer votre CV au format Word pour un template fidèle, et votre modèle de lettre.
5. Définir vos recherches (Recherche → Critères) ; ajouter les employeurs de départ (Recherche → Entreprises) ; créer vos alertes e-mail sur LinkedIn, Indeed, WTTJ, Apec, eFinancialCareers et Mon Volontariat International.
6. Régler AUTOPILOT (Paramètres → Candidature) : plateformes, pays, contrats, seuils, consentements ; installer l'extension et lui donner un jeton « apply ».
7. Compléter vos informations de candidature (droit au travail par pays, prétentions par pays, disponibilité, préavis…).
8. Pour le suivi par email : créer un identifiant OAuth dans Google Cloud et connecter Gmail.
9. Mettre en place la sauvegarde quotidienne et tester une restauration.
