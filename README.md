# File d'appels — priorisation des leads inbound

Outil interne : transforme l'export quotidien de leads Salesforce (PDF Printable
View ou CSV) en une **file d'appels priorisée** — qui appeler, dans quel ordre,
aujourd'hui.

Site **statique**, sans build et sans backend : `index.html` + `styles.css` +
`app.js` + `columns.js` + `pdf-csv.js`, avec PapaParse et pdf.js servis depuis
`vendor/` (aucune requête tierce).

## Confidentialité — la règle du projet

**Ni le CSV ni le PDF ne sont envoyés sur un serveur.** Tout le parsing, la
conversion PDF, le scoring et l'historique se passent dans le navigateur. C'est
un choix de conception (zéro friction + confidentialité des données leads) : ne
pas l'inverser sans décision explicite.

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

Au chargement, l'app affiche des **données de démonstration** tant qu'aucun
fichier n'est chargé. Boutons « Charger un CSV » / « Importer un PDF Printable
View », ou glisser-déposer (`.csv` comme `.pdf`).

## Import : PDF Printable View, CSV, et correspondance des colonnes

**PDF (recommandé)** — l'export Salesforce « Printable View » se charge tel
quel : plus besoin de le faire convertir en CSV par un outil tiers, la
conversion se fait dans ta page avec pdf.js. Ce que fait le convertisseur :

1. il repère la **ligne d'en-tête** et en déduit les colonnes, quel que soit
   leur ordre — y compris quand un en-tête passe à la ligne
   (« Last Outbound / Call Date ») ou qu'il est réimprimé à chaque page ;
2. il **redécoupe les en-têtes agglutinés** : sur des colonnes serrées, pdf.js
   renvoie plusieurs en-têtes dans un seul fragment de texte, et sans ce
   découpage les colonnes suivantes disparaissent avec leurs valeurs ;
3. il **mesure la grille de colonnes dans les données** plutôt que de la
   déduire des en-têtes : dans un tableau, toutes les valeurs d'une colonne
   commencent au même x. Les positions des en-têtes redécoupés ne sont
   qu'estimées et font baver les valeurs d'une colonne sur sa voisine ;
4. les lignes sont **ancrées sur le téléphone**, et les fragments sont
   regroupés **par colonne** en cellules : chaque cellule rejoint l'ancre la
   plus proche de son milieu. Cela couvre les deux mises en page — cellules
   calées en haut, et cellules **centrées verticalement** comme dans le
   Printable View, où la suite d'une cellule se trouve au-dessus de la ligne
   qui porte le téléphone. Titres et pieds de page sont écartés ;
5. décimales à virgule et dates `JJ.MM.AAAA` / `JJ/MM/AAAA` sont conservées
   telles quelles ;
6. une colonne **« Dernier appel par »** est dérivée (IA vs Commercial, à ~8 min
   près), la même règle que le score.

Le bouton **« Télécharger le CSV »** récupère le CSV issu du PDF, si tu veux le
garder ou le rejouer plus tard.

**Écran de correspondance des colonnes** — si le nom ou le téléphone n'est pas
reconnu, un écran s'ouvre pour désigner « telle colonne = GA Source », etc.,
avec l'aperçu de la première valeur de chaque colonne. Il reste accessible à
tout moment via **« Corriger les colonnes »**. C'est ce qui permet à un autre
commercial, dont l'export a d'autres intitulés, d'utiliser l'outil.

Quand un groupe d'en-têtes est trop aggloméré pour être découpé de façon sûre,
les colonnes concernées sont laissées en « Colonne N » avec un avertissement,
plutôt que mal nommées : un libellé connu posé sur les mauvaises données serait
pire. L'écran de correspondance, avec son aperçu des valeurs, permet alors de
trancher.

Limite connue : si le PDF coupe un mot en plein milieu pour le faire tenir dans
une colonne (`Comptoirdesgourma` / `nds`), les deux morceaux sont recollés avec
une espace. Les retours à la ligne normaux (entre deux mots) et les mots coupés
sur un trait d'union (`google-` / `demandgen`) sont, eux, reconstitués
correctement.

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

- `ingestRows` / `applyMapping` / `openMapper` — import unifié CSV + PDF et
  écran de correspondance des colonnes
- `columns.js` — dictionnaire des colonnes attendues et détection souple
  (`matchColumn`, `autoMap`), partagé par le PDF et l'écran de correspondance
- `pdf-csv.js` — `findHeaderBlocks` (en-têtes multi-lignes / répétés),
  `splitHeaderCells` (en-têtes agglutinés par pdf.js), `dataColumns` (grille
  mesurée dans les données), `extractRows` / `splitCells` (ancrage sur le
  téléphone, cellules centrées ou calées en haut), `deriveCaller`, `toCSV`
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
