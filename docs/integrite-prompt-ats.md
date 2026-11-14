# Intégrité du prompt ATS

Votre prompt ATS est exécuté tel que vous l'avez écrit. Ce document explique comment
JobAgent le garantit, comment vous pouvez le vérifier vous-même, et quels tests protègent
cette garantie.

## Ce qui est transmis au modèle

Un seul message, construit ainsi :

1. **Votre prompt, à l'identique.** Seules les mentions « Copier/coller » des lignes
   « ■ CV : » et « ■ Offre d'emploi : » (ou les jetons `{{CV}}` / `{{OFFRE}}`) sont remplacées.
   Sans ces mentions, le CV et l'offre sont ajoutés après le prompt, sans en retirer un espace.
2. **Le CV complet** : le texte extrait de votre document (PDF ou Word importé pour le master,
   PDF produit pour un CV personnalisé). Le fichier PDF est joint quand le fournisseur le permet
   (API Anthropic), pour que le format réel soit évalué. Aucune précision, aucune note n'est
   ajoutée au CV évalué : vos précisions servent au CV personnalisé, noté à son tour.
3. **L'offre complète** : intitulé, entreprise, lieu, adresse et texte intégral de l'annonce,
   encadrés comme donnée externe (une consigne cachée dans une annonce n'est jamais suivie).

Une consigne système courte accompagne le message : exécuter le prompt fidèlement, sans rien
retirer ni ajouter, et traiter l'annonce comme une donnée. Elle ne contient **aucune règle de
notation** ; son empreinte est enregistrée avec chaque analyse.

## La preuve, à chaque analyse

Avant l'appel au modèle :

- le prompt lu en base est comparé à son empreinte SHA-256 enregistrée ;
- le message assemblé est « démonté » : en remettant les mentions d'origine à la place du CV
  et de l'offre, on doit retrouver exactement le prompt enregistré (même empreinte SHA-256).

Si l'une de ces vérifications échoue, **l'analyse n'est pas lancée** et la raison apparaît dans
le centre de validation.

Après l'appel, l'empreinte du message **réellement transmis** est relevée là où il part :
dans le corps de la requête HTTP envoyée à l'API Anthropic (texte, consigne système et octets
du PDF joint), ou sur l'entrée standard de Claude Code. Elle doit être identique à celle du
message vérifié ; sinon l'analyse est marquée inutilisable et aucune décision n'en est tirée.

Taille : si le prompt, le CV et l'offre dépassent ce que le modèle peut lire, rien n'est coupé ;
l'analyse n'est pas lancée et le problème vous est signalé. Si le rapport est interrompu par la
limite de longueur, il est relancé avec une limite plus large ; s'il reste incomplet, il est
conservé mais aucune note ni décision n'en est tirée.

Tout est enregistré avec l'analyse et visible sur la fiche de l'offre (« Prompt transmis à
l'identique : vérifié ») : empreintes, longueurs, source du CV, PDF joint ou non, message exact
envoyé (téléchargeable).

## Notes distinctes

| Information | D'où elle vient |
|---|---|
| Note attribuée | Lue dans le rapport de votre prompt (ligne de total ou de note ajustée). C'est la seule utilisée pour décider. |
| Note estimée après optimisation | Projection écrite par le rapport (« devrait atteindre 17/20 », « 17 à 18/20 »). Affichée à part, jamais utilisée pour décider. |
| Note mesurée sur le CV personnalisé | Nouvelle exécution du même prompt sur le CV réellement produit. |
| Recommandation JobAgent | Vos seuils appliqués à la note attribuée. |

Le rapport est conservé intégralement ; la synthèse structurée en est extraite à part.

## Vérifier vous-même

Profil → Prompt ATS :

- **Importer le fichier d'origine** : le texte est enregistré octet pour octet (fins de ligne
  Windows et BOM compris) ; JobAgent affiche l'empreinte du fichier et celle de la version
  enregistrée.
- **Comparer avec mon original** : comparaison caractère par caractère, avec la ligne et la
  colonne de chaque écart.
- **Télécharger le texte exact**, puis sur votre ordinateur : `sha256sum fichier.txt`
  (macOS : `shasum -a 256 fichier.txt`).

## Tests de non-régression

`tests/integration/ats-integrity.test.ts` et `tests/integration/pipeline.test.ts` vérifient :
l'identité du prompt avant et après stockage (espaces insécables, guillemets typographiques,
puces, doubles espaces, tabulations, fins de ligne Windows, accents décomposés, émoji) ; l'import
d'un fichier octet pour octet ; la comparaison ; le corps HTTP réellement produit par le SDK
Anthropic (prompt, CV extrait du PDF, PDF joint à l'octet près, offre complète, consigne
système) ; l'absence de troncature d'une annonce de plus de 100 000 caractères ; le refus, sans
appel au modèle, d'une entrée trop volumineuse ; la relance puis le statut « incomplet » d'un
rapport interrompu ; la restitution du rapport à l'identique ; la note attribuée conservée
quand le rapport annonce une projection (cas 13/20 → 17/20) ; le refus d'analyser un prompt
dont l'empreinte ne correspond plus ; une consigne cachée dans l'offre sans effet sur le prompt.
