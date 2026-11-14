# Moteur de candidature

JobAgent remplit et, quand c'est permis, envoie vos candidatures. Il s'arrête uniquement
sur de vraies exceptions, qu'il vous présente dans le centre de validation, sans jamais vous
faire ressaisir ce qu'il a déjà rempli.

## Trois stratégies

| Stratégie | Quand | Ce que fait JobAgent |
|---|---|---|
| A — API officielle | Jamais disponible pour un candidat : les API de candidature (Greenhouse, Lever, Ashby, SmartRecruiters, Workable…) exigent la clé de l'employeur. Voir [Plateformes](plateformes.md). | Lecture des offres seulement, par les API publiques. |
| B — Navigateur piloté (Playwright) | Plateformes dont l'automatisation n'est pas interdite (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, Teamtailor, Breezy). | Ouvre le formulaire, lit chaque champ et son libellé, répond, joint les documents, passe les étapes, relit chaque valeur, envoie si vos règles le permettent, lit la confirmation. |
| C — Assistance | Plateformes à compte candidat ou protégées (Workday, Taleo, SuccessFactors, iCIMS, SmartRecruiters…), CAPTCHA, envoi qui vous revient. | Prépare tout ; l'extension JobAgent remplit le formulaire dans votre navigateur, joint les documents, signale ce qui reste ; vous envoyez. La confirmation est enregistrée. |

LinkedIn, Indeed et Welcome to the Jungle interdisent l'automatisation : JobAgent prépare la
candidature (documents, réponses) et vous la faites en quelques minutes. Les offres de ces sites
qui renvoient vers le site de l'employeur sont traitées sur ce site.

## Modes

- **VALIDATION** (par défaut) : les formulaires sont remplis, l'envoi vous revient.
- **AUTOPILOT** : vos règles, validées une fois (pays, contrats, intitulés, note ATS attribuée,
  priorité, plateformes, plafonds par jour et par semaine, consentements), permettent l'envoi sans
  validation individuelle. Une candidature qui ne remplit pas toutes les règles repasse en
  VALIDATION. Une annonce contenant un texte adressé à une IA n'est jamais envoyée automatiquement.
- Chaîne complète : offre trouvée → sélection → analyse ATS → CV et lettre dans vos modèles →
  contrôles → (validation automatique des documents si vous l'avez autorisée) → formulaire →
  envoi → confirmation → suivi des e-mails → entretien → préparation.

## Réponses aux formulaires

Chaque champ est rattaché, si possible, à une question connue (identité, coordonnées, droit au
travail par pays, visa, prétentions, disponibilité, préavis, langues, formation…) reconnue en
français, anglais, espagnol et allemand. La réponse vient de vos informations validées, de vos
réponses déjà données, des documents de la candidature ou d'une déduction factuelle (source réelle
de l'offre). Chaque réponse garde sa source et son statut.

Rien n'est inventé : une question inconnue vous est posée **une fois** (avec sa portée : toutes
candidatures, pays, entreprise, offre), puis réutilisée, même formulée autrement. Les données
sensibles (nationalité, date de naissance, rémunération actuelle) ne sont transmises qu'après votre
confirmation. Les déclarations (politique de confidentialité, attestation d'exactitude) ne sont
cochées que si vous l'avez autorisé dans vos règles.

## Interventions (et seulement celles-ci)

CAPTCHA ou contrôle anti-robots, connexion à un compte candidat, code de vérification,
déclaration non autorisée, question inconnue, réponse refusée par la page, formulaire non
reconnu, plateforme sans automatisation. Tout ce qui a été lu et résolu est conservé ; après votre
intervention, l'extension ou une nouvelle exécution remplit à l'identique.

## Garanties

- **Pas de double candidature** : l'envoi est inscrit en base avant le clic ; une interruption
  pendant l'envoi rend la candidature « incertaine » et rien n'est renvoyé sans votre vérification ;
  deux exécutions simultanées n'envoient qu'une candidature.
- **Envoyée = confirmée** : une candidature n'est « envoyée » qu'avec une confirmation réelle
  (page de confirmation lue, accusé de réception par e-mail, ou votre déclaration).
- **Bons documents** : seuls les documents validés de cette candidature sont joints (le format
  Word est choisi si le formulaire n'accepte pas le PDF).
- **Traces** : chaque tentative garde ses étapes, ses captures d'écran, son taux de remplissage
  et son motif d'arrêt (fiche de l'offre → Documents).
- **Jetons cloisonnés** : le jeton de l'extension (portée « apply ») ne donne accès qu'au
  remplissage des candidatures en cours.

## Extension de navigateur

Candidatures → « Extension de navigateur » télécharge le paquet. Installation : voir
`extension/README.md` (Chrome, Edge, Brave ; mode développeur). L'extension ne clique jamais sur
« Envoyer ».

## Indicateurs

Tableau de bord (bandeau AUTOPILOT) et `GET /api/apply/metrics` : taux de remplissage
automatique, candidatures envoyées par le moteur et part sans intervention, durée moyenne d'une
exécution, interventions par motif, envois incertains, échecs.
