# Sauvegarde et restauration

Tout l'état de l'application est dans la base Postgres, documents compris (CV, lettres,
templates et aperçus y sont stockés). Sauvegarder la base, c'est tout sauvegarder — à une
exception près : `APP_SECRET`, qui n'est pas dans la base et qui chiffre vos clés d'API et jetons.

## Ce qu'il faut conserver

1. Une sauvegarde de la base (ci-dessous).
2. La valeur de `APP_SECRET` (dans un gestionnaire de mots de passe).

Sans `APP_SECRET`, une base restaurée reste utilisable, mais les secrets chiffrés doivent être
ressaisis (clé Anthropic, identifiants de sources, connexion Gmail).

## Sauvegarder

Avec Docker Compose :

```bash
scripts/backup.sh
```

Avec une base managée :

```bash
DATABASE_URL="postgres://…" scripts/backup.sh /chemin/des/sauvegardes
```

Le fichier produit (`backups/jobagent-AAAAMMJJ-HHMMSS.dump`, format `pg_dump` compressé) contient
des données personnelles : stockez-le chiffré, hors de la machine. Le dossier `backups/` est
ignoré par git.

Sauvegarde quotidienne à 3 h, en gardant trente jours (crontab de la machine) :

```bash
0 3 * * * cd /chemin/vers/jobagent && scripts/backup.sh >> backups/backup.log 2>&1 && find backups -name '*.dump' -mtime +30 -delete
```

## Restaurer

```bash
scripts/restore.sh backups/jobagent-AAAAMMJJ-HHMMSS.dump
```

Le script demande confirmation, arrête l'application, remplace le contenu de la base, puis la
relance. Vérifiez ensuite : connexion, présence du CV master, liste des offres, et un rendu de
document (Profil → Mes documents).

**Testez une restauration au moins une fois** sur une machine d'essai : une sauvegarde jamais
restaurée n'est pas une sauvegarde.

## Export lisible (portabilité)

Indépendamment des sauvegardes, chaque utilisateur peut exporter ses données dans un fichier
JSON lisible : Paramètres → Données, ou en ligne de commande :

```bash
npm run cli -- export --email vous@exemple.fr --out export.json --files
```

L'export ne contient jamais les secrets. Il sert à la consultation et à la portabilité ; il n'y a
pas de réimport automatique : pour repartir d'un état antérieur, utilisez une sauvegarde de la base.

## Instance locale (base embarquée)

Sans `DATABASE_URL`, la base vit dans le dossier `DATA_DIR` (`./data` par défaut), avec le
secret généré `data/.app-secret`. Pour sauvegarder : arrêtez l'application et copiez ce dossier
entier. Pour restaurer : remettez-le en place.

## Historique et versions

Rien d'important n'est écrasé : chaque version du CV master, du prompt ATS, des templates et de
chaque document de candidature est conservée, et le journal d'activité garde la trace de ce que
l'agent et vous avez fait. Une erreur de manipulation se corrige le plus souvent depuis
l'interface, sans restauration.
