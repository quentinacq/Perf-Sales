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
function findHeaderBlocks(lines){
  const blocks=[];
  for(let i=0;i<lines.length;i++){
    let cells=cellsOf(lines[i]);
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
      const cand=mergeHeaderCells(cells,nc);
      const ch=scoreCells(cand);
      if(ch<hits)break;
      cells=cand;hits=ch;end=k;
    }
    blocks.push({start:i,end,cells,hits});
    i=end;
  }
  return blocks;
}

/* --- 4. colonnes : frontières à mi-chemin entre deux en-têtes --- */
function buildColumns(cells){
  const cols=cells.map((c,i)=>({name:c.str,x:c.x,xEnd:c.x+c.w,i}));
  cols.forEach((c,i)=>{
    const prev=cols[i-1],next=cols[i+1];
    c.left = prev?(prev.xEnd+c.x)/2 : -Infinity;
    c.right= next?(c.xEnd+next.x)/2 :  Infinity;
  });
  // noms uniques : deux colonnes homonymes resteraient indiscernables
  const seen={};
  cols.forEach(c=>{const n=c.name;seen[n]=(seen[n]||0)+1;if(seen[n]>1)c.name=n+' ('+seen[n]+')';});
  return cols;
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

/* --- 5 & 6. lignes ancrées sur le téléphone, puis colonne dérivée --- */
function extractRows(lines,blocks,cols,warnings){
  const map=global.LeadColumns.autoMap(cols.map(c=>c.name));
  const phoneCol=map['Phone'];
  if(!phoneCol)warnings.push("Colonne téléphone non reconnue : le découpage des lignes est moins fiable.");
  const skip=new Set();
  blocks.forEach(b=>{for(let i=b.start;i<=b.end;i++)skip.add(i);});
  const start=blocks[0].start+1;
  const rows=[];let prev=null;                     // dernière ligne retenue (pour l'écart vertical)
  for(let i=start;i<lines.length;i++){
    if(skip.has(i))continue;
    const line=lines[i];
    const cells=lineCells(cols,line);
    const values=Object.values(cells).filter(Boolean);
    if(!values.length)continue;
    if(values.length<=3&&values.some(v=>FOOTER_RE.test(v)))continue;   // pied de page / titre

    const anchored=phoneCol?hasPhone(cells[phoneCol]):values.some(hasPhone);
    if(anchored){rows.push(cells);prev=line;}
    else if(rows.length&&prev&&prev.page===line.page&&prev.y-line.y<=fontOf(line)*2.2){
      // suite de la ligne précédente : cellule qui déborde sur deux lignes
      const last=rows[rows.length-1];
      Object.entries(cells).forEach(([k,v])=>{last[k]=last[k]?last[k]+' '+v:v;});
      prev=line;
    }
  }
  if(!rows.length&&lines.length>start)
    warnings.push("Aucune ligne avec un téléphone reconnu — vérifie que le PDF est bien un export « Printable View ».");
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
  const cols=buildColumns(main.cells);
  const rows=extractRows(lines,blocks,cols,warnings);
  const headers=cols.map(c=>c.name);
  if(deriveCaller(rows,cols))headers.push('Dernier appel par');
  const missing=global.LeadColumns.missingImportant(global.LeadColumns.autoMap(headers));
  if(missing.length)warnings.push('Colonnes non reconnues automatiquement : '+missing.join(', ')+'.');
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

global.PdfCsv={convert,toCSV,groupLines,cellsOf,findHeaderBlocks,buildColumns,extractRows,parseDate,PHONE_RE};
})(window);
