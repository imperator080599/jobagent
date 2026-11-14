# Extension JobAgent (Chrome, Edge, Brave — Manifest V3)

Remplit, dans **votre** navigateur, les formulaires des candidatures préparées par JobAgent,
avec vos réponses validées et les documents de la candidature. Elle sert quand l'envoi vous
revient : CAPTCHA, compte candidat (Workday, Taleo…), code de vérification, plateformes où
JobAgent ne fait que préremplir.

- Elle ne clique **jamais** sur « Envoyer » et ne touche à aucun CAPTCHA ni contrôle d'accès.
- Elle n'agit pas sur LinkedIn, Indeed ni Welcome to the Jungle (conditions d'utilisation).
- Elle n'invente rien : les réponses viennent de JobAgent (profil validé, réponses déjà données).
- Après votre envoi, la confirmation affichée par la page est enregistrée dans JobAgent.

## Installation (mode développeur)

1. Dans JobAgent : Paramètres → Accès → créer un jeton de portée « apply ».
2. Télécharger le paquet de l'extension depuis JobAgent (Candidatures → Extension), le décompresser.
3. `chrome://extensions` → activer le mode développeur → « Charger l'extension non empaquetée ».
4. Ouvrir les réglages de l'extension : adresse de votre JobAgent + jeton.

Le fichier `inpage.js` est copié depuis `src/apply/engine/inpage.js` lors de la création du paquet
(même code de lecture des formulaires que le moteur de candidature).
