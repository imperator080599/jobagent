# Intégrations externes

Chaque intégration se configure dans l'interface. Aucune n'est indispensable au démarrage :
une intégration absente désactive seulement ce qui en dépend, et le centre de validation dit
ce qu'il manque.

## Modèles d'IA (Anthropic)

- **Où** : Paramètres → IA et budget. La clé est chiffrée en base ; elle peut aussi être fournie
  par la variable `ANTHROPIC_API_KEY`.
- **Modèles** : un modèle principal (analyse ATS, CV, lettre) et un modèle économique (sélection,
  extractions, contrôles). Les deux sont modifiables.
- **Budget** : plafonds quotidien et mensuel ; une fois atteints, les tâches attendent.
- **Sans clé** : la sélection fonctionne en mode dégradé (règles seules) ; l'analyse ATS, les
  documents et le classement fin des emails attendent la clé.
- **Mode démonstration** : `LLM_PROVIDER=mock` simule tous les agents, sans réseau ni coût.

## Sources d'offres

| Source | Accès | Identifiants | Couverture déclarée |
|---|---|---|---|
| Greenhouse | API publique « Job Board » | aucun | complète (toutes les offres en une réponse) |
| Lever | API publique « Postings » | aucun | complète (pagination jusqu'au bout) |
| Ashby | API publique « Job Postings » | aucun | complète |
| SmartRecruiters | API publique « Posting » | aucun | complète ; texte chargé offre par offre pour les seules offres pertinentes |
| France Travail | API officielle « Offres d'emploi v2 » | identifiant et clé secrète gratuits (francetravail.io) | complète jusqu'à 3 150 résultats par requête, sinon partielle avec la raison |
| Adzuna | API officielle | `app_id` et `app_key` gratuits (developer.adzuna.com) | complète ; extraits seulement (texte complet demandé avant analyse) |
| Flux RSS / Atom | flux publié par le site | aucun | toujours partielle (un flux ne montre que les offres récentes) |
| Alertes email | vos propres emails d'alerte, via Gmail | connexion Gmail | partielle ; texte complet à coller |
| Ajout manuel | adresse ou texte collé | aucun | — |

Règles communes :

- Un site carrières se déclare en collant son adresse (Recherche → Sources) : la plateforme est
  reconnue et configurée automatiquement.
- Une source n'est dite « lue en entier » que si son connecteur l'affirme. Plafond atteint, page
  en erreur ou flux partiel donnent une lecture « partielle », avec la raison.
- Une offre n'est déclarée retirée qu'après une lecture complète de sa source où elle n'apparaît plus.
- Un refus d'accès (401, 403, 429, CAPTCHA) n'est jamais contourné : la source passe « en panne »
  et vous êtes prévenu.

**Sites non lus automatiquement** : LinkedIn, Indeed, Welcome to the Jungle, Glassdoor, les sites
Workday et, plus généralement, tout site qui interdit la lecture automatisée. Pour eux : ajout
manuel, ou import de vos alertes email. Aucune offre V.I.E n'est collectée automatiquement
(pas d'API publique documentée) : utilisez les alertes email de Mon Volontariat International.

## Gmail

- **Où** : Paramètres → Messagerie. La connexion passe par la page d'autorisation de Google
  (OAuth 2.0 avec PKCE) ; aucun mot de passe n'est demandé ni stocké.
- **Prérequis** : un projet Google Cloud à votre nom, avec « Gmail API » activée et un identifiant
  OAuth de type « Application Web » dont l'adresse de redirection est celle affichée dans l'écran
  de connexion (`<APP_URL>/api/mail/gmail/callback`). Publiez l'écran de consentement « En
  production » : en mode « Test », Google fait expirer l'accès au bout de sept jours.
- **Deux autorisations distinctes** :
  - lecture (`gmail.readonly`) — suivre les réponses à vos candidatures ;
  - rédaction (`gmail.compose`) — déposer des brouillons dans votre messagerie. Elle n'est
    demandée que si vous la choisissez.
- **Ce qui est lu** : uniquement les messages correspondant à une recherche restreinte
  (vocabulaire de candidature, entreprises auxquelles vous avez postulé, expéditeurs de
  plateformes de recrutement). Les pièces jointes ne sont jamais ouvertes. Seuls les messages
  liés à vos candidatures sont conservés.
- **Ce qui n'est jamais fait** : envoyer un message. Les réponses et relances sont des brouillons
  que vous relisez et envoyez vous-même.
- **Révocation** : bouton « Révoquer l'accès » (le jeton est révoqué chez Google et effacé), ou
  depuis votre compte Google.

## LinkedIn

Trois voies officielles, au choix (Profil → LinkedIn) :

1. l'archive « Obtenir une copie de vos données » (fichier ZIP) ;
2. le PDF « Enregistrer au format PDF » de votre profil ;
3. l'API « Member Data Portability » (jeton d'accès que vous générez vous-même), pour une
   vérification périodique.

Les écarts avec le CV master sont présentés un par un ; rien n'est synchronisé à l'aveugle et
une décision prise n'est jamais redemandée. Aucun identifiant LinkedIn n'est demandé, et le site
n'est jamais parcouru.

## Notifications

Paramètres → Notifications : ntfy (téléphone), Telegram (bot), webhook signé (Make, Zapier,
Slack…). Les événements urgents choisis sont signalés sans attendre ; le reste passe par le
résumé quotidien, à l'heure de votre fuseau.

## Documents (LibreOffice)

La conversion Word → PDF et le contrôle du rendu utilisent LibreOffice en mode sans interface et
poppler. Ils sont inclus dans l'image Docker. Sans eux, les documents Word sont tout de même
produits ; les PDF et leur contrôle sont indiqués comme en attente.
