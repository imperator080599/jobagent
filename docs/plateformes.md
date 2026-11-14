# Plateformes : ce qui est permis, et la preuve

> Document généré depuis `src/apply/platforms.ts` (`npx tsx scripts/gen-platforms-doc.mts`). Conditions vérifiées le 2026-11-13 ; elles peuvent évoluer.

Règles : JobAgent ne contourne ni CAPTCHA, ni protection anti-robots, ni restriction d'accès. Le plafond d'automatisation
d'une plateforme n'est jamais dépassé, quel que soit le réglage. Quand l'automatisation est interdite ou impossible, la
meilleure alternative autorisée est utilisée (alertes e-mail, site de l'employeur, préparation complète pour une
candidature manuelle en quelques minutes).

## Synthèse

| Plateforme | Lecture des offres | Alertes e-mail | API de candidature pour candidat | Automatisation du navigateur | Envoi automatique | Plafond retenu |
|---|---|---|---|---|---|---|
| Greenhouse | API publique Job Board (GET boards-api.greenhouse.io), sans authentification (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| Lever | API publique Postings (GET api.lever.co/v0/postings/{site}) (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| Ashby | API publique posting-api (GET api.ashbyhq.com/posting-api/job-board/{org}) (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| SmartRecruiters | API publique Posting (GET api.smartrecruiters.com/v1/companies/{id}/postings) (permise) | — | non | restreinte | restreinte | Remplissage automatique, envoi par vous |
| Workday | Pages carrière publiques de chaque employeur (lecture espacée) (non interdite (aucune interdiction trouvée)) | oui | non | restreinte | restreinte | Remplissage automatique, envoi par vous |
| Workable | Widget public des offres (apply.workable.com) (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| Recruitee | API publique des pages carrière ({entreprise}.recruitee.com/api/offers) (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| Personio | Flux XML public des offres ({entreprise}.jobs.personio.de/xml) (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| Teamtailor | Pages carrière publiques (non interdite (aucune interdiction trouvée)) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| iCIMS | Pages carrière publiques (non interdite (aucune interdiction trouvée)) | oui | non | restreinte | restreinte | Remplissage automatique, envoi par vous |
| Oracle Taleo | Pages carrière publiques (non interdite (aucune interdiction trouvée)) | oui | non | restreinte | restreinte | Remplissage automatique, envoi par vous |
| SAP SuccessFactors | Pages carrière publiques (non interdite (aucune interdiction trouvée)) | oui | non | restreinte | restreinte | Remplissage automatique, envoi par vous |
| Breezy HR | Flux JSON public ({entreprise}.breezy.hr/json) (permise) | — | non | non interdite (aucune interdiction trouvée) | non interdite (aucune interdiction trouvée) | Remplissage et envoi automatiques (si vous l’autorisez) |
| Jobvite | Pages carrière publiques (non interdite (aucune interdiction trouvée)) | — | non | non vérifiée | non vérifiée | Remplissage automatique, envoi par vous |
| BambooHR | Pages carrière publiques ({entreprise}.bamboohr.com/careers) (non interdite (aucune interdiction trouvée)) | — | non | non interdite (aucune interdiction trouvée) | non vérifiée | Remplissage automatique, envoi par vous |
| LinkedIn | Aucune lecture automatisée : alertes e-mail de LinkedIn lues dans votre boîte, import de vos exports (interdite) | oui | non | interdite | interdite | Préparation seulement, candidature faite par vous |
| Indeed | Alertes e-mail d’Indeed lues dans votre boîte (restreinte) | oui | non | interdite | interdite | Préparation seulement, candidature faite par vous |
| Welcome to the Jungle | Alertes e-mail de WTTJ lues dans votre boîte ; lien de chaque offre conservé (interdite) | oui | non | interdite | interdite | Préparation seulement, candidature faite par vous |
| Apec | Alertes e-mail de l’Apec lues dans votre boîte (non vérifiée) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| France Travail | API officielle « Offres d'emploi » temporairement retirée ; alertes e-mail (restreinte) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| HelloWork | Alertes e-mail lues dans votre boîte (non vérifiée) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| Glassdoor | Alertes e-mail lues dans votre boîte (non vérifiée) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| JobTeaser | Alertes e-mail de votre école lues dans votre boîte (non vérifiée) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| eFinancialCareers | Alertes e-mail lues dans votre boîte (non vérifiée) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| Mon Volontariat International (VIE/VIA) | Alertes e-mail de votre espace candidat ; pages publiques des offres (non vérifiée) | oui | non | non vérifiée | non vérifiée | Préparation seulement, candidature faite par vous |
| Candidature par e-mail | Adresse indiquée dans l’annonce (permise) | — | non | permise | restreinte | Remplissage automatique, envoi par vous |
| Site carrière de l'entreprise | Page publique de l’offre (lecture espacée) (non interdite (aucune interdiction trouvée)) | — | non | non interdite (aucune interdiction trouvée) | non vérifiée | Remplissage automatique, envoi par vous |

## Détail et preuves

### Greenhouse

- API de candidature : La soumission par API (POST Job Board) exige la clé d'API de l'employeur : réservée aux sites carrière des entreprises.
- Interventions humaines prévisibles : CAPTCHA éventuel au moment de l’envoi ; questions propres à l’employeur jamais rencontrées.
- MyGreenhouse (compte candidat) interdit les moyens automatisés : JobAgent ne l'utilise pas et passe par le formulaire public de l'employeur.
- Preuve (2026-11-13) — « (POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}) requires Basic Auth. The Job Board API Key must be Base64 encoded before it can be used to post applications. » — <https://docs.greenhouse.io/job-board.html>
- Preuve (2026-11-13) — « You agree that you will not … (z) use automated means, including spiders, robots, crawlers, or similar means or processes to access or use the Services. » — <https://my.greenhouse.io/users/agreement>

### Lever

- API de candidature : L'envoi par API (POST /postings/:id/apply) exige une clé générée par un administrateur de l'employeur.
- Interventions humaines prévisibles : CAPTCHA (hCaptcha) souvent présent à l’envoi : transmis à l’utilisateur, jamais contourné.
- Preuve (2026-11-13) — « To use the POST API, you need an API key, which a Super Admin of your account can generate from your integrations settings page. » — <https://github.com/lever/postings-api>

### Ashby

- API de candidature : applicationForm.submit est destiné aux sites carrière des employeurs et s'authentifie avec leur clé d'API.
- Interventions humaines prévisibles : CAPTCHA éventuel.
- Preuve (2026-11-13) — « Submit the core application form … POST https://api.ashbyhq.com/applicationForm.submit (guide destiné aux employeurs qui construisent leur propre page carrière). » — <https://developers.ashbyhq.com/docs/creating-a-custom-careers-page>
- Preuve (2026-11-13) — « curl https://api.ashbyhq.com/application.list -u API_KEY: … » — <https://developers.ashbyhq.com/reference/authentication>

### SmartRecruiters

- API de candidature : L'Application API est réservée aux clients et partenaires de SmartRecruiters.
- Interventions humaines prévisibles : envoi par l’utilisateur ; contrôle anti-robots (DataDome) possible.
- Protection anti-robots dédiée aux candidatures automatisées : JobAgent remplit le formulaire dans votre navigateur (extension) et vous laisse l'envoyer, sans chercher à passer ce contrôle.
- Preuve (2026-11-13) — « The Application API enables our customers and partners to integrate the SmartRecruiters application process into their own career site or job board. » — <https://developers.smartrecruiters.com/docs/application-api-1>
- Preuve (2026-11-13) — « SmartRecruiters enjoys stronger bot protection, and can ensure applications are from genuine job seekers, not bots or automated scripts. » — <https://datadome.co/customers-stories/smartrecruiters-crushes-spam-job-applications-without-disrupting-real-users/>
- Preuve (2026-11-13) — « Use automatic means to access content or data from other users; (Candidate Terms of Use, last modified on 14th May 2019) » — <https://www.smartrecruiters.com/legal/terms-of-use/>

### Workday

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : création ou connexion au compte candidat de l’employeur (mot de passe saisi par vous, jamais stocké en clair) ; vérification de l’adresse e-mail ; envoi final.
- Un compte par employeur, protégé par mot de passe : le formulaire en plusieurs étapes est rempli dans votre navigateur par l’extension, à partir de vos réponses enregistrées.
- Preuve (2026-11-13) — « When you visit the Workday Recruitment site, we use cookies, tracking pixels, and scripts. (Chaque employeur exploite son propre site, avec compte candidat.) » — <https://www.workday.com/en-us/privacy/recruiting-privacy-statement.html>

### Workable

- API de candidature : L'API de Workable est réservée aux comptes employeurs.
- Interventions humaines prévisibles : CAPTCHA en cas de trafic jugé suspect.
- Workable signale aux recruteurs les candidatures « AI-assisted » : votre candidature peut porter cette mention. JobAgent utilise toujours votre véritable adresse e-mail.
- Preuve (2026-11-13) — « Once a candidate applies to a Workable job that triggers the blacklist attributes … The candidate is tagged as AI-assisted. … Rate limiting, bot management, and CAPTCHA for suspicious traffic. » — <https://help.workable.com/hc/en-us/articles/35293126257815-Managing-AI-assisted-and-automated-job-applications>

### Recruitee

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Aucune clause trouvée sur l'automatisation : envoi automatique possible si vous l’autorisez, arrêt sur tout contrôle anti-robots.

### Personio

- API de candidature : L'API de candidature de Personio exige un jeton de l'employeur.
- Aucune clause trouvée sur l'automatisation : envoi automatique possible si vous l’autorisez, arrêt sur tout contrôle anti-robots.

### Teamtailor

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : confirmation de l’adresse e-mail demandée par certains employeurs.
- Aucune clause trouvée sur l'automatisation : envoi automatique possible si vous l’autorisez, arrêt sur tout contrôle anti-robots.

### iCIMS

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : compte candidat de l’employeur ; envoi final.
- Formulaires dans des cadres imbriqués et compte candidat : remplissage dans votre navigateur.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### Oracle Taleo

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : compte candidat de l’employeur ; envoi final.
- Compte obligatoire et parcours en plusieurs étapes.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### SAP SuccessFactors

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : compte candidat de l’employeur ; envoi final.
- Compte obligatoire.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### Breezy HR

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Aucune clause trouvée sur l'automatisation : envoi automatique possible si vous l’autorisez, arrêt sur tout contrôle anti-robots.

### Jobvite

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : envoi final.
- Conditions non vérifiées : envoi laissé à l'utilisateur.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### BambooHR

- API de candidature : Aucune API de candidature ouverte aux candidats.
- Interventions humaines prévisibles : envoi final.
- Conditions non vérifiées : envoi laissé à l'utilisateur.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### LinkedIn

- API de candidature : Aucune API de candidature pour les candidats.
- Interventions humaines prévisibles : candidature « Easy Apply » faite par vous, avec les réponses et documents préparés.
- Les offres LinkedIn qui renvoient vers le site de l'employeur sont traitées sur ce site (Greenhouse, Workday…), selon sa propre politique.
- Preuve (2026-11-13) — « Use bots or other automated methods to access the Services, add or download contacts, send or redirect messages; » — <https://www.linkedin.com/legal/user-agreement>

### Indeed

- API de candidature : Indeed Apply n'est ouvert qu'aux partenaires agréés.
- Interventions humaines prévisibles : candidature Indeed Apply faite par vous.
- Les offres Indeed qui renvoient vers le site de l'employeur sont traitées sur ce site.
- Preuve (2026-11-13) — « Use of any automation, scripting, or bots to automate the Indeed Apply process outside of Indeed’s official vendors and tooling is prohibited. » — <https://www.indeed.com/legal>
- Preuve (2026-11-13) — « Submit job applications or other User Content by automated means, in bulk or otherwise, other than by automated tools that the Site explicitly offers or that have been otherwise agreed to in writing with Indeed; » — <https://www.indeed.com/legal>

### Welcome to the Jungle

- API de candidature : Aucune API de candidature pour les candidats.
- Interventions humaines prévisibles : candidature sur le formulaire WTTJ faite par vous.
- Beaucoup d'offres WTTJ renvoient vers l'ATS de l'employeur : elles y sont traitées selon la politique de cet ATS.
- Preuve (2026-11-13) — « Développer, soutenir ou utiliser tout logiciel, dispositif, script, robot ou tout autre moyen ou procédé (y compris, sans s’y limiter, les robots d’indexation, les extensions et modules de navigateur, ou toute autre technologie) pour procéder à une extraction automatisée de données (« scraping ») … (CGU du 27 avril 2026) » — <https://www.welcometothejungle.com/fr/pages/terms>

### Apec

- API de candidature : Aucune API publique.
- Interventions humaines prévisibles : candidature sur le site de l’Apec faite par vous (compte).
- Conditions non vérifiées : aucune automatisation tant que ce n’est pas établi.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### France Travail

- API de candidature : Aucune API de candidature pour les candidats.
- Interventions humaines prévisibles : candidature sur le site de France Travail faite par vous.
- Preuve (2026-11-13) — « L'API Offre d'emploi de France Travail n'est actuellement plus exposée sur www.francetravail.io le temps d'une analyse des modalités de distribution et de réutilisation du service. » — <https://www.data.gouv.fr/dataservices/api-offres-demploi>

### HelloWork

- API de candidature : Aucune API publique.
- Interventions humaines prévisibles : candidature faite par vous.
- Conditions non vérifiées.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### Glassdoor

- API de candidature : Aucune API publique.
- Interventions humaines prévisibles : candidature faite par vous.
- Conditions non vérifiées.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### JobTeaser

- API de candidature : Aucune API publique.
- Interventions humaines prévisibles : candidature faite par vous.
- Accès lié à votre établissement.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### eFinancialCareers

- API de candidature : Aucune API publique.
- Interventions humaines prévisibles : candidature faite par vous.
- Conditions non vérifiées.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### Mon Volontariat International (VIE/VIA)

- API de candidature : Aucune API publique documentée.
- Interventions humaines prévisibles : candidature depuis votre espace Mon Volontariat.
- Candidature rattachée à votre dossier Business France.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### Candidature par e-mail

- API de candidature : —
- Interventions humaines prévisibles : envoi de l'e-mail préparé (sauf autorisation d'envoi donnée dans les paramètres).
- Par défaut, l'e-mail est préparé en brouillon, jamais envoyé sans votre autorisation.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.

### Site carrière de l'entreprise

- API de candidature : —
- Interventions humaines prévisibles : envoi final, sauf autorisation explicite pour les sites carrière.
- Conditions propres à chaque site : l'envoi automatique n'est fait que si vous l'autorisez pour les sites carrière.
- Aucune clause trouvée sur l'automatisation : par prudence, l’envoi vous est laissé.
