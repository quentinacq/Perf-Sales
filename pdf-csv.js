/* ===== PDF « Printable View » -> lignes de tableau =====
   Port navigateur du convertisseur Python de référence. Tout se passe en local
   via pdf.js : le PDF ne quitte pas la machine, comme le CSV.

   Principe (identique au script Python) :
   1. on lit les fragments de texte avec leurs coordonnées ;
   2. on les regroupe en lignes (même ordonnée) ;
   3. on repère la ligne d'EN-TÊTE — celle qui matche le plus de colonnes
      connues — et ses positions donnent les colonnes (ordre quelconque) ;
   4. chaque fragment est rattaché à la colonne qu'il recouvre le plus ;
   5. les lignes sont ANCRÉES SUR LE TÉLÉPHONE : une ligne sans téléphone est
      la suite de la précédente (cellule qui déborde sur 2 lignes) ;
   6. on dérive « Dernier appel par » (IA vs commercial).

   Sortie : lignes indexées par les en-têtes D'ORIGINE du PDF. La
   canonicalisation est faite ensuite par LeadColumns.autoMap, pour que
   l'écran de correspondance puisse encore corriger la détection. */
(function(global){
'use strict';

const PHONE_RE=/(?:\+|00)\s?\d[\d\s.\-()]{6,}|\b0\s?\d(?:[\s.\-]?\d{2}){4}\b/;
const DATE_RE=/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[,\sT]+(\d{1,2}):(\d{2}))?/;
const FOOTER_RE=/(^page\s*\d+\s*$|page\s*\d+\s*(of|sur|\/)\s*\d+|copyright|©|salesforce\.com|printable\s*view|^https?:\/\/\S+$|^\d{1,2}[.\/]\d{1,2}[.\/]\d{4},?\s*\d{1,2}:\d{2}(:\d{2})?$)/i;
const CALL_TOL_MS=8*60*1000; // même tolérance que le score : ~8 min = appel IA

const clean=s=>String(s==null?'':s).replace(/\s+/g,' ').trim();
const hasPhone=s=>PHONE_RE.test(String(s||''));
function parseDate(s){
  if(!s)return null;
  const m=String(s).trim().match(DATE_RE);
  if(!m)return null;
  return new Date(+m[3],+m[2]-1,+m[1],m[4]?+m[4]:0,m[5]?+m[5]:0);
}

/* --- 1. fragments de texte, page par page --- */
async function readItems(file,onProgress){
  if(typeof pdfjsLib==='undefined')throw new Error("Le lecteur PDF n'a pas pu être chargé (vendor/pdf.min.js).");
  const buf=await file.arrayBuffer();
  let pdf;
  try{pdf=await pdfjsLib.getDocument({data:buf,isEvalSupported:false}).promise;}
  catch(e){throw new Error('Fichier PDF illisible ou corrompu ('+(e&&e.message?e.message:e)+').');}
  const items=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const tc=await page.getTextContent();
    tc.items.forEach(it=>{
      const str=it.str;
      if(!str||!str.trim())return;
      const tr=it.transform;
      items.push({page:p,x:tr[4],y:tr[5],w:it.width||0,h:it.height||Math.abs(tr[3])||10,str});
    });
    page.cleanup();
    if(onProgress)onProgress(p,pdf.numPages);
  }
  return{items,pages:pdf.numPages};
}

/* --- 2. regroupement en lignes --- */
function groupLines(items){
  const lines=[];
  const sorted=items.slice().sort((a,b)=>a.page-b.page||b.y-a.y||a.x-b.x);
  let cur=null;
  for(const it of sorted){
    const tol=Math.max(2,it.h*0.5);
    if(cur&&cur.page===it.page&&Math.abs(cur.y-it.y)<=tol){cur.items.push(it);cur.y=(cur.y*(cur.items.length-1)+it.y)/cur.items.length;}
    else{cur={page:it.page,y:it.y,items:[it]};lines.push(cur);}
  }
  lines.forEach(l=>l.items.sort((a,b)=>a.x-b.x));
  return lines;
}

/* Fusionne les fragments voisins d'une même cellule : un écart inférieur à
   ~0,75 corps de police est une espace, au-delà c'est un changement de colonne. */
function cellsOf(line){
  const cells=[];
  for(const it of line.items){
    const last=cells[cells.length-1];
    if(last){
      const gap=it.x-(last.x+last.w);
      const fs=Math.max(last.h,it.h);
      if(gap<=fs*0.75){last.str+=(gap>fs*0.12?' ':'')+it.str;last.w=it.x+it.w-last.x;last.h=Math.max(last.h,it.h);continue;}
    }
    cells.push({x:it.x,w:it.w,h:it.h,str:it.str});
  }
  return cells.map(c=>({...c,str:clean(c.str)})).filter(c=>c.str);
}

/* --- 3. bloc d'en-tête ---
   Un en-tête de colonne étroite passe à la ligne (« Last Outbound / Call Date »)
   et l'en-tête est réimprimé en haut de chaque page. On reconstitue donc un
   BLOC d'en-tête : la ligne qui matche le plus de colonnes, plus les lignes
   suivantes qui la complètent (rattachées à la colonne qu'elles recouvrent). */
const fontOf=line=>{const h=line.items.map(i=>i.h).sort((a,b)=>a-b);return h[Math.floor(h.length/2)]||10;};
const hasDate=s=>DATE_RE.test(String(s||'').trim());

function scoreCells(cells){
  const taken=new Set();let hits=0;
  cells.forEach(c=>{const m=global.LeadColumns.matchColumn(c.str,taken);if(m){taken.add(m.key);hits++;}});
  return hits;
}
/* rattache chaque cellule de la ligne suivante à l'en-tête qu'elle recouvre */
function mergeHeaderCells(base,extra){
  const out=base.map(c=>({...c}));
  extra.forEach(e=>{
    let best=null,bestOv=0;
    out.forEach(c=>{const ov=Math.min(e.x+e.w,c.x+c.w)-Math.max(e.x,c.x);if(ov>bestOv){bestOv=ov;best=c;}});
    if(best){best.str=(best.str+' '+e.str).trim();best.w=Math.max(best.w,e.x+e.w-best.x);}
  });
  return out;
}
/* Quand deux colonnes sont serrées, pdf.js rend leurs deux en-têtes dans UN
   seul fragment (« Last Outbound Call Date Last Form Submission Date ») : la
   deuxième colonne disparaît et ses valeurs tombent dans la première. On
   redécoupe donc une cellule d'en-tête qui matche visiblement deux colonnes.
   Garde-fou : la coupure doit faire nettement mieux que la cellule entière
   (x1,5), sinon « Lead age (hours) » se ferait couper en « Lead » + « age ». */
const SPLIT_GAIN=1.5;
function splitHeaderCell(cell,depth){
  const words=cell.str.split(' ');
  if(words.length<2||(depth||0)>4)return[cell];
  const whole=global.LeadColumns.matchColumn(cell.str,null);
  const base=whole?whole.score:0;
  let best=null;
  for(let i=1;i<words.length;i++){
    const L=words.slice(0,i).join(' '),R=words.slice(i).join(' ');
    const ml=global.LeadColumns.matchColumn(L,null),mr=global.LeadColumns.matchColumn(R,null);
    if(!ml||!mr||ml.key===mr.key)continue;
    const score=ml.score+mr.score;
    if(!best||score>best.score)best={score,L,R};
  }
  if(!best||best.score<base*SPLIT_GAIN||best.score<=base)return[cell];
  // largeurs estimées au prorata du nombre de caractères
  const total=cell.str.length||1;
  const lw=cell.w*(best.L.length/total);
  const left ={...cell,str:best.L,w:lw};
  const right={...cell,str:best.R,x:cell.x+cell.w*((best.L.length+1)/total),w:cell.w-lw};
  return splitHeaderCell(left,(depth||0)+1).concat(splitHeaderCell(right,(depth||0)+1));
}
const splitHeaderCells=cells=>cells.reduce((a,c)=>a.concat(splitHeaderCell(c,0)),[]);

function findHeaderBlocks(lines){
  const blocks=[];
  for(let i=0;i<lines.length;i++){
    let raw=cellsOf(lines[i]);                                 // x exacts (pdf.js)
    let cells=splitHeaderCells(raw);                           // libellés séparés
    if(cells.length<3)continue;
    let hits=scoreCells(cells);
    if(hits<3)continue;
    let end=i;
    for(let k=i+1;k<lines.length&&k<=i+3;k++){                 // 3 lignes de repli max
      const nx=lines[k];
      if(nx.page!==lines[i].page)break;
      if(lines[k-1].y-nx.y>fontOf(nx)*2)break;                 // trop loin : autre bloc
      const nc=cellsOf(nx);
      if(!nc.length)break;
      if(nc.some(c=>hasPhone(c.str)||hasDate(c.str)))break;    // c'est déjà une ligne de données
      const candRaw=mergeHeaderCells(raw,nc);
      const cand=splitHeaderCells(candRaw);
      const ch=scoreCells(cand);
      if(ch<hits)break;
      raw=candRaw;cells=cand;hits=ch;end=k;
    }
    blocks.push({start:i,end,cells,raw,hits});
    i=end;
  }
  return blocks;
}

/* --- 4. colonnes ---
   Les x des en-têtes agglutinés ne sont qu'une estimation au prorata du texte,
   et elle tombe à côté des vraies colonnes (les en-têtes n'ont pas la largeur
   de leur contenu). La grille réelle se lit dans les DONNÉES : dans un
   tableau, toutes les valeurs d'une colonne commencent au même x, et une
   cellule qui passe à la ligne repart de ce même x. On regroupe donc les x de
   début récurrents, et on pose les frontières dans le blanc entre colonnes.
   Marche quel que soit l'alignement — « Lead age (hours) » est calé à droite. */
const CLUST_TOL=4.5;   // deux x à moins de 4,5 pt = même colonne
const MIN_SUPPORT=.06; // une colonne doit se retrouver sur 6 % des lignes

function dataColumns(dataLines){
  const items=[];
  dataLines.forEach(l=>l.items.forEach(it=>items.push(it)));
  if(items.length<20)return null;
  items.sort((a,b)=>a.x-b.x);
  const groups=[];
  items.forEach(it=>{
    const g=groups[groups.length-1];
    if(g&&it.x-g.x<=CLUST_TOL){g.n++;g.end=Math.max(g.end,it.x+it.w);}
    else groups.push({x:it.x,end:it.x+it.w,n:1});
  });
  const min=Math.max(4,Math.round(dataLines.length*MIN_SUPPORT));
  const cols=groups.filter(g=>g.n>=min).map(g=>({x:g.x,xEnd:g.end,name:''}));
  if(cols.length<3)return null;
  cols.forEach((c,i)=>{const p=cols[i-1];c.left=p?(p.xEnd<c.x?(p.xEnd+c.x)/2:c.x-.5):-Infinity;});
  cols.forEach((c,i)=>{c.right=cols[i+1]?cols[i+1].left:Infinity;});
  return cols;
}

/* Repli quand il n'y a pas assez de données pour mesurer la grille. */
function columnsFromHeader(cells){
  const cols=cells.map(c=>({name:c.str,x:c.x,xEnd:c.x+c.w}));
  cols.forEach((c,i)=>{
    const prev=cols[i-1],next=cols[i+1];
    c.left = prev?(prev.xEnd+c.x)/2 : -Infinity;
    c.right= next?(c.xEnd+next.x)/2 :  Infinity;
  });
  return cols;
}

/* Répartit les en-têtes sur les colonnes mesurées. On part des cellules
   BRUTES : leurs x viennent de pdf.js, ils sont exacts, alors que les x des
   morceaux redécoupés ne sont qu'une estimation. Une cellule brute qui couvre
   plusieurs colonnes mesurées est forcément agglutinée, et le nombre de
   colonnes couvertes dit en combien de morceaux la couper. */
function nameColumns(cols,rawCells,warnings){
  const add=(c,t)=>{c.name=c.name?c.name+' '+t:t;};
  rawCells.forEach(cell=>{
    const a=cell.x,b=cell.x+cell.w;
    /* Une colonne est « couverte » si son bord gauche tombe dans la cellule :
       un en-tête aggloméré part du premier bord et enjambe tous les suivants.
       Le simple recouvrement ne suffisait pas — un en-tête plus large que sa
       colonne (« Lead age (hours) ») déborde sur la voisine sans être collé. */
    const hit=cols.filter(c=>c.x>=a-2&&c.x<b-2);
    if(!hit.length){
      const near=cols.filter(c=>Math.min(b,c.right)-Math.max(a,c.left)>1);
      if(near.length)add(near[0],cell.str);
      return;
    }
    if(hit.length===1){add(hit[0],cell.str);return;}
    const parts=splitHeaderCell(cell,0);
    if(parts.length===hit.length){hit.forEach((c,i)=>add(c,parts[i].str));return;}
    if(parts.length===1){add(hit[0],cell.str);return;}   // insécable : en-tête large, pas aggloméré
    /* Découpage partiel : les morceaux déjà isolés à gauche sont sûrs, le
       dernier reste à cheval sur plusieurs colonnes. Mieux vaut ne pas nommer
       que mal nommer — coller un libellé connu sur des données qui ne sont pas
       les siennes ferait correspondre « Nb Of Outbound Calls » à une colonne
       de dates. Les colonnes laissées sans nom deviennent « Colonne N » et
       l'écran de correspondance, avec son aperçu, permet de trancher. */
    for(let i=0;i<parts.length-1;i++)add(hit[i],parts[i].str);
    if(warnings)warnings.push("Un groupe d'en-têtes n'a pas pu être séparé ("
      +JSON.stringify(parts[parts.length-1].str.length>60?parts[parts.length-1].str.slice(0,60)+'…':parts[parts.length-1].str)
      +') : ces colonnes apparaissent sous « Colonne N » dans « Corriger les colonnes ».');
  });
  cols.forEach((c,i)=>{if(!c.name)c.name='Colonne '+(i+1);});
  const seen={};
  cols.forEach(c=>{seen[c.name]=(seen[c.name]||0)+1;if(seen[c.name]>1)c.name+=' ('+seen[c.name]+')';});
  return cols;
}

function buildColumns(block,dataLines,warnings){
  const measured=dataLines&&dataColumns(dataLines);
  if(!measured)return columnsFromHeader(block.cells);   // repli : x estimés
  return nameColumns(measured,block.raw,warnings);
}

/* Rattache un fragment à la colonne qu'il recouvre le plus. Tolère les
   cellules plus larges que leur en-tête (produits à rallonge, sociétés). */
function assign(cols,it){
  let best=null,bestOv=-1;
  for(const c of cols){
    const ov=Math.min(it.x+it.w,c.right)-Math.max(it.x,c.left);
    if(ov>bestOv){bestOv=ov;best=c;}
  }
  return best;
}
function lineCells(cols,line){
  const out={};
  for(const it of line.items){
    const c=assign(cols,it);if(!c)continue;
    const prev=out[c.name];
    out[c.name]=prev?prev+' '+it.str:it.str;
  }
  Object.keys(out).forEach(k=>out[k]=clean(out[k]));
  return out;
}

/* --- 5 & 6. lignes ancrées sur le téléphone, puis colonne dérivée ---
   Une ligne du tableau occupe plusieurs lignes de texte dès qu'une cellule
   déborde, et le repère fiable reste le TÉLÉPHONE : la ligne qui en porte un
   est l'ancre d'un lead. Reste à savoir à quelle ancre rattacher les autres
   lignes, et la distance ne suffit pas : selon que les cellules sont calées en
   haut ou centrées verticalement (le cas du Printable View), la suite d'une
   cellule est sous l'ancre ou de part et d'autre.

   On raisonne donc PAR COLONNE : les fragments d'une même colonne se
   regroupent en cellules (les lignes d'une cellule sont plus serrées que
   l'écart entre deux cellules), et chaque cellule rejoint l'ancre la plus
   proche de son MILIEU. Ce milieu tombe sur l'ancre quand les cellules sont
   centrées, et reste plus près de sa propre ancre que de la suivante quand
   elles sont calées en haut : correct dans les deux cas. */
const joinWrapped=(a,b)=>/-$/.test(a)&&/^[a-z0-9]/i.test(b)?a+b:a+' '+b;

/* Découpe la suite verticale des fragments d'une colonne en cellules. */
function splitCells(frags,anchorYs){
  const gaps=[];
  for(let i=1;i<frags.length;i++)gaps.push(frags[i-1].y-frags[i].y);
  const intra=gaps.length?Math.min.apply(null,gaps):0;
  const th=intra>0?intra*1.4:Infinity;
  const cells=[];let cur=[frags[0]];
  for(let i=1;i<frags.length;i++){
    if(frags[i-1].y-frags[i].y>th){cells.push(cur);cur=[frags[i]];}
    else cur.push(frags[i]);
  }
  cells.push(cur);
  /* Filet : une cellule ne peut pas contenir deux ancres — ce sont alors deux
     leads que l'écart vertical n'a pas su séparer. */
  const out=[];
  cells.forEach(c=>{
    let start=0;
    for(let i=1;i<c.length;i++){
      const dejaUneAncre=c.slice(start,i).some(f=>anchorYs.has(f.y));
      if(dejaUneAncre&&anchorYs.has(c[i].y)){out.push(c.slice(start,i));start=i;}
    }
    out.push(c.slice(start));
  });
  return out;
}

function extractRows(lines,blocks,cols,warnings){
  const map=global.LeadColumns.autoMap(cols.map(c=>c.name));
  const phoneCol=map['Phone'];
  if(!phoneCol)warnings.push("Colonne téléphone non reconnue : le découpage des lignes est moins fiable.");
  const skip=new Set();
  blocks.forEach(b=>{for(let i=b.start;i<=b.end;i++)skip.add(i);});

  const useful=[];
  for(let i=blocks[0].start+1;i<lines.length;i++){
    if(skip.has(i))continue;
    const cells=lineCells(cols,lines[i]);
    const values=Object.values(cells).filter(Boolean);
    if(!values.length)continue;
    if(values.length<=3&&values.some(v=>FOOTER_RE.test(v)))continue;   // pied de page / titre
    useful.push({line:lines[i],cells,anchor:phoneCol?hasPhone(cells[phoneCol]):values.some(hasPhone)});
  }
  const anchors=useful.filter(u=>u.anchor);
  if(!anchors.length){
    warnings.push("Aucune ligne avec un téléphone reconnu — vérifie que le PDF est bien un export « Printable View ».");
    return[];
  }
  // hauteur d'une ligne de tableau = écart médian entre deux ancres voisines
  const gaps=[];
  for(let i=1;i<anchors.length;i++){
    const a=anchors[i-1].line,b=anchors[i].line;
    if(a.page===b.page)gaps.push(a.y-b.y);
  }
  gaps.sort((x,y)=>x-y);
  const pitch=gaps.length?gaps[Math.floor(gaps.length/2)]:24;

  const rows=anchors.map(()=>({}));
  const idxOf=new Map();anchors.forEach((a,i)=>idxOf.set(a,i));
  const pages=[...new Set(useful.map(u=>u.line.page))];

  cols.forEach(col=>{
    pages.forEach(pg=>{
      const anc=anchors.filter(a=>a.line.page===pg);
      if(!anc.length)return;
      const anchorYs=new Set(anc.map(a=>a.line.y));
      const frags=useful.filter(u=>u.line.page===pg&&u.cells[col.name])
                        .map(u=>({y:u.line.y,t:u.cells[col.name]}))
                        .sort((a,b)=>b.y-a.y);
      if(!frags.length)return;
      splitCells(frags,anchorYs).forEach(cell=>{
        const mid=(cell[0].y+cell[cell.length-1].y)/2;
        let best=null,bd=Infinity;
        anc.forEach(a=>{const d=Math.abs(a.line.y-mid);if(d<bd){bd=d;best=a;}});
        // une cellule haute s'éloigne légitimement de son ancre : le plafond
        // tient compte de sa propre hauteur, sinon on perdrait les cellules
        // de 3-4 lignes tout en laissant passer le mobilier de page.
        if(!best||bd>(cell[0].y-cell[cell.length-1].y)/2+pitch*.75)return;
        const txt=cell.reduce((acc,f)=>acc?joinWrapped(acc,f.t):f.t,'');
        const r=rows[idxOf.get(best)];
        r[col.name]=r[col.name]?joinWrapped(r[col.name],txt):txt;
      });
    });
  });
  return rows;
}

/* « Dernier appel par » : dates égales (~8 min) = seul l'appel IA a eu lieu ;
   appel postérieur = le commercial a déjà relancé. */
function deriveCaller(rows,cols){
  const map=global.LeadColumns.autoMap(cols.map(c=>c.name));
  const callCol=map['Last Outbound Call Date'],subCol=map['Last Form Submission Date'];
  if(!callCol||!subCol)return false;
  rows.forEach(r=>{
    const call=parseDate(r[callCol]),sub=parseDate(r[subCol]);
    r['Dernier appel par']=(!call||!sub)?'':((call-sub)>CALL_TOL_MS?'Commercial':'IA');
  });
  return true;
}

async function convert(file,onProgress){
  const warnings=[];
  const{items,pages}=await readItems(file,onProgress);
  if(!items.length)throw new Error('PDF illisible : aucun texte trouvé (PDF scanné ou protégé ?).');
  const lines=groupLines(items);
  const blocks=findHeaderBlocks(lines);
  if(!blocks.length)throw new Error("Aucune ligne d'en-tête reconnue dans ce PDF. Vérifie qu'il s'agit bien d'une vue liste Salesforce (Printable View).");
  const main=blocks.reduce((a,b)=>b.hits>a.hits?b:a,blocks[0]);
  const inHeader=new Set();
  blocks.forEach(bl=>{for(let i=bl.start;i<=bl.end;i++)inHeader.add(i);});
  const dataLines=lines.filter((l,i)=>i>main.end&&!inHeader.has(i));
  const cols=buildColumns(main,dataLines,warnings);
  const rows=extractRows(lines,blocks,cols,warnings);
  const headers=cols.map(c=>c.name);
  if(deriveCaller(rows,cols))headers.push('Dernier appel par');
  // les colonnes manquantes sont signalées par showSource(), avec le lien « Corriger » :
  // pas la peine de le répéter ici.
  // toutes les clés présentes, même vides : PapaParse/CSV attend des lignes homogènes
  rows.forEach(r=>headers.forEach(h=>{if(r[h]==null)r[h]='';}));
  return{headers,rows,pages,warnings};
}

function toCSV(headers,rows){
  const q=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
  return'﻿'+[headers.map(q).join(';')].concat(rows.map(r=>headers.map(h=>q(r[h])).join(';'))).join('\r\n');
}

/* le worker pdf.js est servi depuis le repo, comme le reste : zéro requête tierce */
if(typeof pdfjsLib!=='undefined'&&pdfjsLib.GlobalWorkerOptions)
  pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.min.js',document.baseURI).href;

global.PdfCsv={convert,toCSV,groupLines,cellsOf,splitHeaderCells,findHeaderBlocks,dataColumns,buildColumns,extractRows,parseDate,PHONE_RE};
})(window);
