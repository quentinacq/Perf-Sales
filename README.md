# File d'appels — priorisation des leads inbound

Outil interne : transforme l'export quotidien de leads Salesforce (CSV) en une
**file d'appels priorisée** — qui appeler, dans quel ordre, aujourd'hui.

Site **statique**, sans build et sans backend : `index.html` + `styles.css` +
`app.js`, plus PapaParse chargé par CDN.

## Confidentialité — la règle du projet

**Le CSV n'est envoyé sur aucun serveur.** Tout le parsing, le scoring et
l'historique se passent dans le navigateur. C'est un choix de conception (zéro
friction + confidentialité des données leads) : ne pas l'inverser sans décision
explicite.

Conséquence côté repo : `.gitignore` bloque les `*.csv` et les sauvegardes
d'historique. **Ne commite jamais un export de leads réel.** Le repo doit rester
**privé**, et le partage de l'outil à des collègues attend le feu vert
sécurité/manager (données internes SumUp).

## Lancer en local

Ouvrir `index.html` dans un navigateur suffit. Pour être au plus près de la prod
(mêmes origines, `localStorage` stable) :

```sh
python3 -m http.server 8000   # puis http://localhost:8000
```

Au chargement, l'app affiche des **données de démonstration** tant qu'aucun CSV
n'est chargé. Bouton « Charger un CSV » ou glisser-déposer pour passer sur les
vraies données.

## Déployer sur Vercel

Site statique, aucune configuration de build.

- **Depuis le dashboard** : *Add New… → Project*, importer ce repo (privé),
  Framework Preset **Other**, Build Command *vide*, Output Directory **`.`**,
  puis *Deploy*.
- **En CLI** :
  ```sh
  npx vercel        # préversion
  npx vercel --prod # production
  ```

`vercel.json` fixe les en-têtes (`noindex`, `nosniff`, pas de referrer) et les
URLs propres. Chaque push sur la branche de production redéploie.

Pourquoi une URL fixe : l'historique de performance vit dans le `localStorage`
**de cette origine**. Une URL stable = un historique qui persiste d'un jour à
l'autre, sans « rouvrir le bon fichier ».

## Export / import de l'historique

Onglet **Performance**, deux boutons :

- **Exporter l'historique** → télécharge un JSON
  `{ version, exportedAt, weights, perfHistory }`. Un fichier local, rien ne
  part sur le réseau.
- **Importer l'historique** → relit un JSON et **fusionne par date** ; les
  pondérations du scoring sont restaurées si le fichier en contient.

Règles de fusion (on n'écrase jamais bêtement) :

1. une journée absente est ajoutée ;
2. une journée réelle remplace toujours une journée de démonstration ;
3. à statut égal, la journée la plus fournie (nombre d'appels le plus élevé)
   gagne.

C'est le filet de sécurité contre un cache vidé ou un changement de poste, en
attendant un éventuel backend. Prendre l'habitude d'exporter en fin de semaine.

## Repères code

- `mapRow` / `pick` — parsing et mapping souple des colonnes CSV
- `scoreLead` — score ; `tierOf` / `prio` — les 3 paliers et le tri
- `render` — rendu principal (rappels, stats, pool) ; `renderFocus` — mode focus
- `renderPerf` — panneau du jour ; `renderPerfPage` + `svgLine` — page Performance
- `loadHistory` / `saveHistory` / `seedHistory` / `commitToday` — historique
- `exportHistory` / `importHistory` / `mergeHistory` — sauvegarde JSON
- `W` / `DEFAULTS` / `CTRLS` — pondérations et curseurs

La logique métier (paliers, frais < 72 h toujours en tête, backlog inclus mais
déprioritisé, détection appel humain vs IA) est décrite dans `CLAUDE.md` §5 et
**se conserve telle quelle**.
