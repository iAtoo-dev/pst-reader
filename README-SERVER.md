# PST Archive — Installation sur Ubuntu

## Prérequis

- Node.js 20+ (`nvm install 20`)
- Fichiers PST accessibles sur le serveur

## Installation

```bash
# 1. Cloner / copier le projet
git clone https://github.com/meuse24/pst-reader pst-archive
cd pst-archive

# 2. Installer les dépendances du serveur
npm install

# 3. Construire le frontend (Node.js 20+ requis)
cd pst-viewer
npm install
npm run build
cd ..
```

## Configuration

Copier `.env.example` en `.env` et ajuster :

```bash
cp .env.example .env
nano .env
```

```env
PST_DIR=/chemin/vers/vos/fichiers/pst
PST_PASSWORD=motdepasse_securise
PORT=3000
```

## Démarrage

```bash
# Avec dotenv-cli
npm install -g dotenv-cli
dotenv -- node server.js

# Ou en exportant les variables manuellement
PST_DIR=/data/pst PST_PASSWORD=secret PORT=3000 node server.js
```

## Démarrage automatique (systemd)

Créer `/etc/systemd/system/pst-archive.service` :

```ini
[Unit]
Description=PST Archive Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/pst-archive
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PST_DIR=/data/pst-files
Environment=PST_PASSWORD=motdepasse_securise
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable pst-archive
sudo systemctl start pst-archive
sudo systemctl status pst-archive
```

## Fonctionnement

### Première ouverture
- Le serveur sert les fichiers PST avec support des range requests
- Chaque worker (un par fichier PST) parse la structure du fichier via des requêtes HTTP fragmentées
- L'index des métadonnées emails est construit et persisté en IndexedDB dans le navigateur
- **Durée estimée :** quelques secondes à quelques minutes selon la taille des PST

### Ouvertures suivantes
- Les métadonnées sont chargées depuis IndexedDB **instantanément**
- Les fichiers PST ne sont accédés que pour les corps d'emails et les pièces jointes
- **Durée :** < 5 secondes pour tout charger

### Gestion mémoire
- Seuls les dossiers récemment consultés restent en RAM (LRU)
- IndexedDB stocke l'index complet (~1 KB/email × nombre d'emails)
- Les corps d'emails et pièces jointes sont toujours lus à la demande depuis le serveur

## Sécurité

- Authentification HTTP Basic Auth (mot de passe configuré via `PST_PASSWORD`)
- Prévention de la traversée de répertoires (basename uniquement)
- Recommandé : déployer derrière nginx avec HTTPS

### Exemple nginx

```nginx
server {
    listen 443 ssl;
    server_name pst.example.com;

    ssl_certificate     /etc/letsencrypt/live/pst.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pst.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
