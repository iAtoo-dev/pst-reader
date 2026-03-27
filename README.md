# PST Archive — Serveur d'archives email

Fork de [meuse24/pst-reader](https://github.com/meuse24/pst-reader) adapté pour servir plusieurs fichiers PST volumineux depuis un serveur, sans upload.

## Cas d'usage

Vous avez plusieurs fichiers PST (sauvegardes d'une même boîte mail) stockés sur un serveur Ubuntu et souhaitez permettre à un collaborateur de les parcourir, rechercher et exporter depuis un navigateur web — sans jamais copier les fichiers.

## Fonctionnalités

- **Multi-PST** : charge plusieurs fichiers PST simultanément (un Web Worker par fichier)
- **Boîte fusionnée** : les dossiers identiques sont fusionnés (ex. tous les "Inbox" en un seul), emails triés par date
- **Accès HTTP range** : les fichiers PST ne sont jamais copiés — seuls les chunks nécessaires sont lus à la demande via des requêtes HTTP range
- **Persistance IndexedDB** : les métadonnées sont indexées une seule fois et stockées dans le navigateur ; les sessions suivantes sont instantanées
- **Authentification** : HTTP Basic Auth avec mot de passe configurable
- **Export EML** : export des emails en fichiers `.eml` ou ZIP
- **Recherche** : recherche plein texte (objet, expéditeur, destinataire, corps, pièces jointes)

## Architecture

```
server.js                          # Backend Express (Basic Auth, range requests, /api/pst-files)
pst-viewer/src/
  useMultiPSTWorker.ts             # Hook React multi-PST (remplace usePSTWorker)
  pstWorker.ts                     # Worker : LOAD_URL + persistance IndexedDB
  types.ts                         # Types partagés (+ commande LOAD_URL)
  App.tsx                          # UI (sans upload, mode serveur)
```

### Première ouverture

1. Le serveur liste les fichiers PST via `/api/pst-files`
2. Un Web Worker par fichier PST charge la structure via des requêtes HTTP range synchrones
3. Les métadonnées de chaque email sont indexées et persistées en IndexedDB (`pst-viewer-email-cache`, clé `filename:filesize`)
4. Durée : quelques secondes à quelques minutes selon la taille des PST

### Ouvertures suivantes

- Les métadonnées sont rechargées depuis IndexedDB **instantanément** (< 5 secondes)
- Les fichiers PST ne sont accédés que pour les corps d'emails et les pièces jointes

## Installation

### Prérequis

- Node.js 20+ (`nvm install 20`)
- Fichiers PST accessibles sur le serveur

### Étapes

```bash
# 1. Cloner le projet
git clone https://github.com/iAtoo-dev/pst-reader pst-archive
cd pst-archive

# 2. Installer les dépendances du serveur
npm install

# 3. Construire le frontend
cd pst-viewer
npm install
npm run build
cd ..
```

### Configuration

```bash
cp .env.example .env
nano .env
```

```env
PST_DIR=/chemin/vers/vos/fichiers/pst
PST_PASSWORD=motdepasse_securise
PORT=3000
```

### Démarrage

```bash
# Avec dotenv-cli
npm install -g dotenv-cli
dotenv -- node server.js

# Ou directement
PST_DIR=/data/pst PST_PASSWORD=secret PORT=3000 node server.js
```

### Démarrage automatique (systemd)

Voir [README-SERVER.md](README-SERVER.md) pour la configuration systemd et nginx.

## Sécurité

- Authentification HTTP Basic Auth (timing-safe)
- Prévention de la traversée de répertoires (basename uniquement)
- Recommandé : déployer derrière nginx avec HTTPS

## Crédits

Basé sur [pst-reader](https://github.com/meuse24/pst-reader) de [meuse24](https://github.com/meuse24).
