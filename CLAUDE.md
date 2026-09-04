# File d'appels — outil de priorisation de leads inbound (SumUp)

Brief de reprise pour Claude Code. Ce fichier explique ce qu'est le projet,
comment il marche, la logique métier à **préserver absolument**, et les tâches
à réaliser. Le code est éclaté en `index.html` + `styles.css` + `app.js`
+ `columns.js` (dictionnaire de colonnes) + `pdf-csv.js` (conversion PDF), avec
PapaParse et pdf.js servis depuis `vendor/`. HTML/CSS/JS vanilla, aucun build.
Déployé comme site statique sur Vercel.

---

## 1. Ce que c'est

Outil **interne** utilisé par un commercial *inbound* chez SumUp (Quentin). Il
transforme l'export quotidien de ses leads Salesforce (un CSV) en une **file
d'appels priorisée** : qui appeler, dans quel ordre, aujourd'hui.

- Tourne **100 % dans le navigateur**. Le CSV n'est envoyé sur **aucun serveur**.
  C'est un choix de conception (simplicité + confidentialité des données leads)
  à **conserver**.
- Deux pages (onglets) : **« File d'appels »** (la liste du jour) et
  **« Performance »** (tableau de bord jour / semaine avec courbes).

## 2. Mission immédiate — faite

1. **Git + hébergement Vercel** ✅ — site statique, zéro backend, zéro build.
   Le monolithe a été éclaté en `index.html` / `styles.css` / `app.js`, à
   comportement identique. `vercel.json` fixe les en-têtes (`noindex`,
   `nosniff`, pas de referrer) ; procédure de déploiement dans le `README.md`.
   Une **URL fixe** = un `localStorage` stable = l'historique persiste d'un jour
   à l'autre. **Le repo doit rester privé** (données métier internes SumUp).
2. **Boutons « Exporter / Importer l'historique »** ✅ — onglet Performance, à
   droite du sélecteur Jour/Semaine.
   - *Exporter* (`exportHistory`) : JSON `{app,version,exportedAt,weights,perfHistory}`.
   - *Importer* (`importHistory` + `mergeHistory`) : **fusion par date**, jamais
     d'écrasement aveugle — une journée absente est ajoutée ; une journée réelle
     bat toujours une journée de démo (les jours semés portent `demo:true`) ; à
     statut égal la journée la plus fournie gagne. Les pondérations `W` sont
     restaurées si le fichier en contient, puis re-render.
   - JSON invalide ou sans historique → message d'erreur, rien n'est touché.

3. **Convertisseur PDF -> CSV intégré** ✅ (`pdf-csv.js`) — bouton « Importer un
   PDF Printable View ». Plus besoin de passer par un convertisseur tiers : le
   PDF est lu dans le navigateur avec pdf.js, donc **il ne sort pas de la
   machine** (c'était le trou dans la raquette : jusqu'ici l'export partait chez
   un tiers). Port de la logique du script Python de référence :
   - détection des colonnes **par leur en-tête**, ordre quelconque
     (`findHeaderBlocks` + `LeadColumns.matchColumn`) ;
   - en-têtes **sur plusieurs lignes** (« Last Outbound / Call Date » dans une
     colonne étroite) reconstitués, en-tête **répété à chaque page** ignoré ;
   - en-têtes **agglutinés** redécoupés (`splitHeaderCells`) : quand deux
     colonnes sont serrées, pdf.js rend leurs en-têtes dans un seul fragment
     (« Prospect product interest Lead age (hours) Last Outbound Call Date… »)
     et les colonnes suivantes disparaissaient, valeurs comprises. La coupure
     n'est retenue que si elle fait nettement mieux (x1,5) que la cellule
     entière, sinon « Lead age (hours) » se ferait couper en « Lead » + « age » ;
   - chaque fragment est rattaché à la colonne qu'il **recouvre le plus** ;
   - lignes **ancrées sur le téléphone** : une ligne sans téléphone est la suite
     de la précédente (cellule qui déborde) ; pieds de page filtrés ;
   - décimales à virgule et dates `JJ.MM.AAAA` / `JJ/MM/AAAA` préservées telles
     quelles (c'est `mapRow` qui les interprète, comme pour le CSV) ;
   - colonne dérivée **« Dernier appel par »** (IA vs Commercial, tolérance
     ~8 min), cohérente avec `humanCalled` du score ;
   - bouton « Télécharger le CSV » pour garder le CSV converti.
4. **Écran de correspondance des colonnes** ✅ — s'ouvre tout seul quand la
   détection auto ne trouve pas le nom ou le téléphone, et reste accessible via
   « Corriger les colonnes ». Un `<select>` par champ attendu, avec l'aperçu de
   la première valeur de la colonne choisie. Les colonnes qui comptent dans le
   score mais n'ont pas été trouvées sont signalées sous le titre.

Note : PapaParse et pdf.js sont servis depuis `vendor/` au lieu d'un CDN —
l'outil marche hors ligne / derrière un réseau d'entreprise verrouillé, et
n'émet plus aucune requête tierce depuis une page qui manipule des données leads.

## 3. Lancer / tester

Ouvrir `index.html` dans un navigateur (ou `python3 -m http.server 8000` pour
être au plus près de la prod). Au chargement, l'app affiche
des **données de démonstration** (générées en JS) tant qu'aucun CSV n'est chargé.
Bouton « Charger un CSV », « Importer un PDF Printable View », ou
glisser-déposer (`.csv` comme `.pdf`) pour passer sur des vraies données.
Les CSV réels ne sont **pas** versionnés : `.gitignore` bloque `*.csv` pour
qu'aucun export de leads n'entre dans le repo.

## 4. Format des données d'entrée (CSV ou PDF)

Export issu de Salesforce, vue liste → Printable View. Le **PDF** se charge
directement (§2.3) ; le **CSV** reste accepté. Dans les deux cas les
colonnes sont **détectées automatiquement** par correspondance souple (fonction
`pick`), donc l'ordre et la casse importent peu. Colonnes attendues :

`Company` · `Name` · `Phone` · `Prospect product interest` · `Lead age (hours)` ·
`Last Outbound Call Date` · `Call back date` · `GA Source` ·
`Last Form Submission Date` — plus optionnel `Business type`.

Particularités de format (déjà gérées, à ne pas casser) :
- **Décimales à virgule** : `12,50` (âge en heures).
- **Dates** `JJ.MM.AAAA, HH:MM` **ou** `JJ/MM/AAAA HH:MM` (les deux acceptées).
- Délimiteur `;` ou `,` (auto-détecté par PapaParse).
- `Nb Of Outbound Calls` peut être présent mais est **cumulatif et non fiable** →
  volontairement **exclu du score** (badge indicatif seulement).
- Si une colonne clé manque à la détection, l'**écran de correspondance**
  (§2.4) prend le relais — c'est ce qui rend l'outil utilisable par un autre
  commercial dont l'export diffère.

## 5. Logique de scoring — À PRÉSERVER (décidée avec le commercial)

Chaque lead est scoré par `scoreLead(L)`, puis trié en **3 paliers** via
`tierOf` + comparateur `prio` :

- **Palier 0 (toujours en tête) : leads frais `< 72h`** (`fresh`). Speed-to-lead :
  un nouveau lead encore chaud passe avant tout le reste.
- **Palier 1 : leads actifs `72h → 14j`**, classés par score.
- **Palier 2 : backlog `> 14j`** (`expired`, seuil `W.expire = 336h`). **Inclus
  mais jamais prioritaire** — toujours en bas. (Règle explicite : on ne veut plus
  les exclure, juste les déprioriser ; ils deviendront l'exception avec le temps.)
- À l'intérieur d'un palier : score décroissant, puis fraîcheur.

Composantes du score (poids dans `W` / `DEFAULTS`, **tous réglables** en direct
via les curseurs du panneau « Réglages » — `CTRLS`) :

| Bloc | Détail | Poids par défaut |
|---|---|---|
| Temporel — jamais relancé | base si non relancé par un humain | `fresh 28` |
| Temporel — fenêtre 48h | bonus si `âge < 48h` | `win48 15` |
| Temporel — relancé récemment | `< 48h` depuis mon appel (on temporise) | `recent 6` |
| Temporel — à relancer | 48–120h depuis mon appel | `due 22` |
| Temporel — relance en retard | `> 120h` | `overdue 30` |
| Temporel — dernière chance | `âge > expire−72` (dernières 72h avant 14j) | `last 12` |
| Source | haute / basse / moyenne | `srcHi 20` / `srcLo 7` / mid ≈14 |
| Produit | fort / faible + bonus combo | `prodHi 15` / `prodLo 5` / `combo +3` |
| Historique | compte rattaché (déjà connu) | `hist 8` |

Autres réglages : `pool 25` (taille de la liste du jour), `expire 336` (14j en h),
`maxCalls 3` (plafond d'appels affiché en badge, visuel uniquement).

**Tiers de source** (`sourceTier`) — reflète que Google/SEO/marketplace convertit
mieux que Meta et les agrégateurs :
- **hi** : `organic`, `google*` (google, google-sea, google-max, google-demandgen),
  `bing`, `referral`, `marketplace`, `seo`
- **bas** : `facebook`, `tiktok`, `hipto`, `companeo`
- (à faire : classer `legalstart`, apparu récemment — actuellement « moyenne »)

**Produit** : fort = contient `POS Plus` / `POS Pro` / `Kiosk` ; faible = `Terminal`
/ `Payment` seul ; bonus si plusieurs produits (combo).

**Détection appel humain vs IA** (règle centrale) : une IA appelle chaque lead en
amont, donc `Nb Of Outbound Calls ≥ 1` toujours. On distingue en comparant
`Last Outbound Call Date` et `Last Form Submission Date` :
- dates **égales** (à ~8 min près) → seul l'appel automatique de l'IA a eu lieu →
  **jamais relancé par le commercial** → priorité haute ;
- date d'appel **postérieure** → le commercial a déjà appelé → on temporise.

**Rappels programmés** (gérés dans `render`, hors score) : un lead avec un
`Call back date` aujourd'hui/à venir (fenêtre −2h..+28h) est sorti dans une section
« Rappels » (c'est un engagement, ça prime sur le score) ; un rappel dépassé
(jusqu'à 7 j) est signalé « en retard » ; au-delà, ignoré (donnée périmée).

## 6. Fonctionnalités en place

- **Marquer « appelé »** (`calledSet`, session) : le lead sort et le suivant
  remonte → la liste des 25 se réalimente en continu.
- **Mode focus** (`renderFocus`) : carte « prochain appel » + avance auto ;
  clavier `C`/`Entrée` = appelé, `S` = passer.
- **Badge tentatives** `nbCalls/max` (`attBadge`) — visuel, hors score.
- **Détection de doublons** (`computeDups`) : même téléphone ou même nom → badge.
- **Copier le nom** (`cpName`) : icône ⧉ pour retrouver le lead dans Salesforce.
- Recherche, filtres (chips), tri, export de la liste du jour en CSV (`exportCSV`).
- **Import PDF Printable View** (`loadPDF` → `PdfCsv.convert`) et **écran de
  correspondance des colonnes** (`openMapper`) — voir §2.3 et §2.4.
- **Page Performance** (`renderPerfPage`) : vue Jour (appels/jour sur 14j + moyenne
  mobile 7j) et vue Semaine (cette semaine vs semaine dernière), courbes SVG
  dessinées maison (`svgLine`), + mini-panneau « Performance du jour »
  (`renderPerf`) sur la page d'appels.

## 7. Persistance & contrainte connue

- `perfHistory` est sauvegardé en `localStorage` (`loadHistory`/`saveHistory`/
  `commitToday`), **entouré de try/catch**. Dans un iframe sandboxé (aperçu
  Claude), `localStorage` est bloqué → l'historique ne persiste pas ; en local ou
  hébergé, il persiste. `seedHistory` génère ~27 jours de démo quand c'est vide
  (marqués `demo:true` pour qu'un import réel les remplace toujours).
- Filet de sécurité : `exportHistory`/`importHistory` (§2). À exporter en fin de
  semaine tant qu'il n'y a pas de backend.
- `calledSet` est **par session** (repart à zéro au rechargement du CSV = nouvelle
  journée). Envisageable de le persister aussi (localStorage, guardé) — voir roadmap.
- **Ne PAS utiliser** de storage non supporté ailleurs ; garder les accès storage
  tolérants aux erreurs.

## 8. Garde-fous (important)

- **Aucune donnée lead ne doit sortir vers un serveur** sans décision explicite.
  C'est à la fois le confort (zéro friction) et l'argument sécurité/conformité.
- **Préserver les règles métier** de la section 5 telles quelles (paliers, frais
  <72h toujours en tête, backlog inclus-mais-déprioritisé, POS Plus = fort,
  détection humain vs IA). Elles ont été calées avec le commercial et comptent.
- **Repo privé**, et **feu vert sécurité/manager** avant de partager l'outil à des
  collègues (données internes SumUp). Point non juridique — à valider en interne.
- Design system existant à respecter (variables CSS `:root`, classes `.tag`,
  `.badge`, `.kpi`…). Nouveaux éléments = même patte visuelle.

## 9. Roadmap (après les tâches immédiates)

- Persister `calledSet` entre rechargements (localStorage guardé). Aujourd'hui il
  repart à zéro au rechargement : la page Performance montre alors 0 appel du
  jour tant qu'on n'a pas re-marqué, même si `perfHistory` a bien gardé le total.
- Classer la source `legalstart` (et vérifier les variantes google).
- **Backend** (ex. Supabase) uniquement si besoin réel : historique multi-appareils
  et fonctions d'équipe (classement partagé, config commune). C'est l'étape qui
  justifie de vraies précautions data côté SumUp.
- Calibrer les pondérations sur les conversions réelles (quand la data d'issue
  d'appel sera disponible).

## 10. Repères code (`app.js`)

`mapRow`/`pick` (parsing+mapping CSV) · `scoreLead` (score) · `tierOf`/`prio`
(paliers & tri) · `render` (rendu principal, RDV, stats, pool) · `renderFocus`
(mode focus) · `renderPerf` (mini-panneau du jour) · `renderPerfPage` +
`svgLine` (page Performance) · `computeDups` · `cpName` · `phoneHTML` ·
`toggleCalled` · `exportCSV` · `W`/`DEFAULTS`/`CTRLS` (pondérations & curseurs) ·
`loadHistory`/`saveHistory`/`seedHistory`/`commitToday` (historique perf) ·
`exportHistory`/`importHistory`/`mergeHistory`/`sanitizeDay` (sauvegarde JSON) ·
`ingestRows`/`applyMapping`/`openMapper` (import unifié CSV+PDF et écran de
correspondance).

`columns.js` : `COLUMNS` (dictionnaire des colonnes attendues + synonymes) ·
`matchColumn` (correspondance pondérée égal > commence par > contient) ·
`autoMap` · `missingRequired`/`missingImportant`. **Une seule source de vérité**
pour la détection dans le PDF et pour l'écran de correspondance.

`pdf-csv.js` : `readItems` (pdf.js) · `groupLines` · `cellsOf` ·
`findHeaderBlocks` (en-têtes multi-lignes et répétés) · `buildColumns`/`assign`
(rattachement par recouvrement) · `extractRows` (ancrage sur le téléphone) ·
`deriveCaller` (« Dernier appel par ») · `toCSV`.
