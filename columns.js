/* ===== Dictionnaire de colonnes — partagé =====
   Une seule source de vérité pour :
   - la détection des en-têtes dans le PDF Printable View (pdf-csv.js) ;
   - l'auto-mapping et l'écran de correspondance des colonnes (app.js).
   Les clés canoniques sont les noms de colonnes de l'export Salesforce ;
   `mapRow` (app.js) les retrouve ensuite via `pick`. */
(function(global){
'use strict';

/* `pats` : fragments cherchés dans l'en-tête normalisé (minuscules, sans
   espaces ni ponctuation). Le fragment le PLUS LONG qui matche gagne, ce qui
   évite que « Last Outbound Call Date » soit pris pour « Call back date ». */
const COLUMNS=[
  {key:'Name',                      label:'Nom du lead',        req:'essentiel', pats:['fullname','leadname','contactname','interlocuteur','name','nom','lead','contact']},
  {key:'Phone',                     label:'Téléphone',          req:'essentiel', pats:['mobilephone','phonenumber','lignedirecte','phone','mobile','telephone','téléphone','numero','numéro','tel']},
  {key:'Company',                   label:'Entreprise',         req:'optionnel', pats:['companyname','company','account','compte','entreprise','societe','société','enseigne']},
  {key:'Prospect product interest', label:'Produit demandé',    req:'important', pats:['prospectproductinterest','productinterest','prospectproduct','produitsouhaite','product','produit']},
  {key:'Lead age (hours)',          label:'Âge du lead (h)',    req:'important', pats:['leadagehours','leadage','agehours','agedulead','anciennete','ancienneté','age']},
  {key:'Last Outbound Call Date',   label:'Dernier appel sortant', req:'important', pats:['lastoutboundcalldate','lastoutboundcall','outboundcalldate','dernierappel','derniercontact','appelsortant','contactsortant','lastcalldate','lastcall']},
  {key:'Last Form Submission Date', label:'Soumission du formulaire', req:'important', pats:['lastformsubmissiondate','lastformsubmission','formsubmission','submissiondate','datedemande','demanderecue','soumission']},
  {key:'Call back date',            label:'Rappel programmé',   req:'important', pats:['callbackdate','callback','rappelprogramme','rappel','rdv']},
  {key:'GA Source',                 label:'Source (GA)',        req:'important', pats:['gasource','leadsource','origine','provenance','source','canal','utmsource']},
  {key:'Business type',             label:'Type de commerce',   req:'optionnel', pats:['businesstype','typeofbusiness','typedecommerce','commerce','natureof','activite','activité']},
  {key:'Nb Of Outbound Calls',      label:'Nb d\'appels sortants', req:'optionnel', pats:['nbofoutboundcalls','numberofoutboundcalls','nboutboundcalls','outboundcalls','nbofoutbound','nbcalls','nbappels']},
  {key:'Dernier appel par',         label:'Dernier appel par',  req:'derive',    pats:['dernierappelpar','lastcalledby','calledby','appelepar']}
];

/* Colonnes sans lesquelles la file d'appels n'a pas de sens. Si l'une manque à
   la détection auto, on ouvre l'écran de correspondance. */
const REQUIRED=['Name','Phone'];
/* Colonnes qui pèsent dans le score : leur absence dégrade le tri, on la signale. */
const IMPORTANT=COLUMNS.filter(c=>c.req==='important').map(c=>c.key);

const norm=s=>String(s==null?'':s).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')  // accents
  .replace(/[^a-z0-9]/g,'');                             // espaces & ponctuation

/* Renvoie {key,score} de la meilleure colonne pour cet en-tête, ou null.
   Un en-tête COMMENCE en général par son mot distinctif : « Origine du contact »
   est une source, pas un nom de contact. D'où la pondération
   égal (x3) > commence par (x2) > contient (x1), à longueur de motif égale.
   `taken` : clés déjà attribuées, pour ne pas mapper deux fois la même. */
function matchColumn(header,taken){
  const h=norm(header);
  if(!h)return null;
  let best=null;
  for(const c of COLUMNS){
    if(taken&&taken.has(c.key))continue;
    for(const p of c.pats){
      const pn=norm(p);
      if(!pn||!h.includes(pn))continue;
      const score=pn.length*(h===pn?3:h.startsWith(pn)?2:1);
      if(!best||score>best.score)best={key:c.key,len:pn.length,score};
    }
  }
  return best;
}

/* headers[] -> { canonique: en-tête source }. Les en-têtes les plus
   spécifiques sont attribués d'abord : « GA Source » avant « Source ». */
function autoMap(headers){
  const cands=[];
  headers.forEach(h=>{const m=matchColumn(h,null);if(m)cands.push({header:h,key:m.key,score:m.score});});
  cands.sort((a,b)=>b.score-a.score);
  const map={},taken=new Set(),used=new Set();
  cands.forEach(c=>{if(!taken.has(c.key)&&!used.has(c.header)){map[c.key]=c.header;taken.add(c.key);used.add(c.header);}});
  return map;
}

const missingRequired=map=>REQUIRED.filter(k=>!map[k]);
const missingImportant=map=>IMPORTANT.filter(k=>!map[k]);

global.LeadColumns={COLUMNS,REQUIRED,IMPORTANT,norm,matchColumn,autoMap,missingRequired,missingImportant};
})(window);
