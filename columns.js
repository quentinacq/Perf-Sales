/* ===== Dictionnaire de colonnes — partagé =====
   Une seule source de vérité pour :
   - la détection des en-têtes dans le PDF Printable View (pdf-csv.js) ;
   - l'auto-mapping et l'écran de correspondance des colonnes (app.js) ;
   - le message « colonnes manquantes » affiché après un import.
   Les clés canoniques SONT les noms exacts des colonnes de l'export Salesforce :
   c'est ce qu'on affiche à l'utilisateur quand il doit les ajouter à sa vue.
   `mapRow` (app.js) les retrouve ensuite via `pick`. */
(function(global){
'use strict';

/* `pats` : fragments cherchés dans l'en-tête normalisé (minuscules, sans
   espaces ni ponctuation). Le fragment le PLUS LONG qui matche gagne, ce qui
   évite que « Last Outbound Call Date » soit pris pour « Call back date ».
   `use` : à quoi la colonne sert — repris tel quel dans le message d'absence,
   pour que « ajoute cette colonne » soit une consigne motivée. */
const COLUMNS=[
  {key:'Name',                      label:'Nom du lead',        req:'essentiel', use:'identifier le lead dans la file et le retrouver dans Salesforce', pats:['fullname','leadname','contactname','interlocuteur','name','nom','lead','contact']},
  {key:'Phone',                     label:'Téléphone',          req:'essentiel', use:'appeler le lead — sans ce champ la file n’a pas d’objet', pats:['mobilephone','phonenumber','lignedirecte','phone','mobile','telephone','téléphone','numero','numéro','tel']},
  {key:'Company',                   label:'Entreprise',         req:'optionnel', use:'afficher l’entreprise sur la fiche du lead', pats:['companyname','company','account','compte','entreprise','societe','société','enseigne']},
  {key:'Prospect product interest', label:'Produit demandé',    req:'important', use:'bloc « Produit » du score (POS Plus / POS Pro / Kiosk = fort)', pats:['prospectproductinterest','productinterest','prospectproduct','produitsouhaite','product','produit']},
  {key:'Lead age (hours)',          label:'Âge du lead (h)',    req:'important', use:'paliers de priorité : frais < 72 h, actif, backlog > 14 j', pats:['leadagehours','leadage','agehours','agedulead','anciennete','ancienneté','age']},
  {key:'Last Outbound Call Date',   label:'Dernier appel sortant', req:'important', use:'détecter si TU as déjà relancé, ou seulement l’appel IA', pats:['lastoutboundcalldate','lastoutboundcall','outboundcalldate','dernierappel','derniercontact','appelsortant','contactsortant','lastcalldate','lastcall']},
  {key:'Last Form Submission Date', label:'Soumission du formulaire', req:'important', use:'comparée au dernier appel sortant pour cette même détection', pats:['lastformsubmissiondate','lastformsubmission','formsubmission','submissiondate','datedemande','demanderecue','soumission']},
  {key:'Call back date',            label:'Rappel programmé',   req:'important', use:'sortir les rappels du jour dans la section « Rappels programmés »', pats:['callbackdate','callback','rappelprogramme','rappel','rdv']},
  {key:'GA Source',                 label:'Source (GA)',        req:'important', use:'bloc « Source » du score (organic / google / referral = haut)', pats:['gasource','leadsource','origine','provenance','source','canal','utmsource']},
  {key:'Business type',             label:'Type de commerce',   req:'optionnel', use:'afficher le type de commerce sur la fiche du lead', pats:['businesstype','typeofbusiness','typedecommerce','commerce','natureof','activite','activité']},
  {key:'Nb Of Outbound Calls',      label:'Nb d\'appels sortants', req:'optionnel', use:'badge « tentatives » — indicatif, volontairement hors score', pats:['nbofoutboundcalls','numberofoutboundcalls','nboutboundcalls','outboundcalls','nbofoutbound','nbcalls','nbappels']},
  {key:'Dernier appel par',         label:'Dernier appel par',  req:'derive',    use:'colonne calculée par le convertisseur PDF, pas à ajouter dans Salesforce', pats:['dernierappelpar','lastcalledby','calledby','appelepar']}
];

const byKey=k=>COLUMNS.find(c=>c.key===k)||null;

/* Colonnes sans lesquelles la file d'appels n'a pas de sens. Si l'une manque à
   la détection auto, on ouvre l'écran de correspondance. */
const REQUIRED=['Name','Phone'];
/* Colonnes qui pèsent dans le score : leur absence dégrade le tri, on la signale. */
const IMPORTANT=COLUMNS.filter(c=>c.req==='important').map(c=>c.key);
/* Colonnes de confort : absentes, l'affichage est moins riche, le tri est intact. */
const OPTIONAL=COLUMNS.filter(c=>c.req==='optionnel').map(c=>c.key);

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
   spécifiques sont attribués d'abord : « GA Source » avant « Source ».
   Le tri départage les ex æquo sur la longueur du motif puis sur l'en-tête
   lui-même, JAMAIS sur la position de la colonne dans le fichier : deux
   exports aux mêmes colonnes dans un ordre différent donnent le même
   mapping (c'est ce qui rend l'ordre des colonnes indifférent). */
function autoMap(headers){
  const cands=[];
  (headers||[]).forEach(h=>{const m=matchColumn(h,null);if(m)cands.push({header:h,key:m.key,len:m.len,score:m.score});});
  cands.sort((a,b)=>b.score-a.score||b.len-a.len||String(a.header).localeCompare(String(b.header))||String(a.key).localeCompare(String(b.key)));
  const map={},taken=new Set(),used=new Set();
  cands.forEach(c=>{if(!taken.has(c.key)&&!used.has(c.header)){map[c.key]=c.header;taken.add(c.key);used.add(c.header);}});
  return map;
}

const missingRequired=map=>REQUIRED.filter(k=>!(map||{})[k]);
const missingImportant=map=>IMPORTANT.filter(k=>!(map||{})[k]);
const missingOptional=map=>OPTIONAL.filter(k=>!(map||{})[k]);

/* Bilan d'un import, prêt à afficher : chaque entrée porte le nom EXACT de la
   colonne Salesforce à ajouter (`key`), son intitulé lisible et ce qu'on perd
   sans elle. `blocking` = l'outil ne peut pas fonctionner tel quel. */
function missingReport(map){
  const of=keys=>keys.map(k=>{const c=byKey(k)||{};return{key:k,label:c.label||k,use:c.use||''};});
  const required=of(missingRequired(map)),important=of(missingImportant(map)),optional=of(missingOptional(map));
  return{required,important,optional,
    blocking:required.length>0,
    total:required.length+important.length+optional.length,
    any:required.length>0||important.length>0};
}

global.LeadColumns={COLUMNS,REQUIRED,IMPORTANT,OPTIONAL,norm,byKey,matchColumn,autoMap,
  missingRequired,missingImportant,missingOptional,missingReport};
})(window);
