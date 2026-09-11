const DEFAULTS={pool:25,expire:336,maxCalls:3,fresh:28,win48:15,recent:6,due:22,overdue:30,last:12,srcHi:20,srcLo:7,prodHi:15,prodLo:5,combo:3,hist:8};
let W={...DEFAULTS};
let LEADS=[];
let calledSet=new Set();
let query='',activeFilter='all',sortMode='score',selIdx=-1;
let focusMode=false,skipSet=new Set(),dupSet=new Set();
const CALL_TOL_MS=8*60*1000;
/* Identité d'un lead, indépendante de son id interne : permet de retrouver les
   leads déjà appelés après un ré-import ou une correction des colonnes. */
const leadKey=L=>(L.phone||'').replace(/\D/g,'').slice(-9)+'|'+(L.name||'').toLowerCase().trim();

function parseNum(s){if(s==null||s==='')return NaN;return parseFloat(String(s).replace(',','.').replace(/\s/g,''));}
function parseDate(s){if(!s)return null;const m=String(s).trim().match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[,\sT]+(\d{1,2}):(\d{2}))?/);if(m)return new Date(+m[3],+m[2]-1,+m[1],m[4]?+m[4]:0,m[5]?+m[5]:0);const d=new Date(s);return isNaN(d)?null:d;}
function pick(row,names){const keys=Object.keys(row);for(const n of names){const hit=keys.find(k=>k.toLowerCase().replace(/[\s_]/g,'').includes(n));if(hit&&row[hit]!=null&&row[hit]!=='')return row[hit];}return'';}
/* Les lignes arrivent avec les colonnes canoniques (ingestRows -> applyMapping),
   donc on lit la colonne attendue DIRECTEMENT quand elle existe. `pick` reste le
   repli souple, mais il ne doit plus servir quand la colonne est simplement
   vide : il partait alors chercher une voisine et un lead sans nom héritait de
   son âge (« 611,89 » comme nom). */
function field(row,canon,names){
  if(Object.prototype.hasOwnProperty.call(row,canon)){const v=row[canon];return v==null?'':String(v);}
  return pick(row,names);
}
let _id=0;
function mapRow(row){
  const sub=parseDate(field(row,'Last Form Submission Date',['lastformsubmission','submissiondate','formsubmission']));
  const call=parseDate(field(row,'Last Outbound Call Date',['lastoutboundcall','outboundcall','lastcall']));
  const ageRaw=parseNum(field(row,'Lead age (hours)',['leadage','agehours','age']));
  return {id:++_id,
    name:field(row,'Name',['name','lead','contact'])||'—',
    company:field(row,'Company',['company','account','compte'])||'',
    phone:field(row,'Phone',['phone','mobile','tel','téléphone','telephone'])||'',
    product:field(row,'Prospect product interest',['prospectproduct','productinterest','product','produit'])||'',
    source:(field(row,'GA Source',['gasource','source','canal'])||'').toLowerCase(),
    biz:field(row,'Business type',['businesstype','typeofbusiness','commerce','natureof'])||'',
    ageHours:isNaN(ageRaw)?(sub?(Date.now()-sub)/3.6e6:0):ageRaw,
    subDate:sub,lastCall:call,
    callback:parseDate(field(row,'Call back date',['callback','callbackdate','rappel'])),
    nbCalls:parseNum(field(row,'Nb Of Outbound Calls',['nbofoutbound','outboundcalls','nbcalls']))||0};
}
function sourceTier(src){if(/organic|google|bing|referral|seo|marketplace/.test(src))return'hi';if(/facebook|meta|insta|hipto|tiktok|companeo/.test(src))return'lo';return'mid';}
function productScore(p){const s=(p||'').toLowerCase();const strong=/pos plus|pos pro|kiosk|caisse/.test(s);const weakOnly=/terminal|payment|reader|tpe/.test(s)&&!strong;let base=strong?W.prodHi:(weakOnly?W.prodLo:Math.round((W.prodHi+W.prodLo)/2));const combo=(p||'').split(/[;,]/).map(x=>x.trim()).filter(Boolean).length>1;return base+(combo?W.combo:0);}
function scoreLead(L){
  const expired=L.ageHours>W.expire;
  const lastChance=!expired && L.ageHours>W.expire-72;
  const fresh=!expired && L.ageHours<72;
  const parts={};let reason,tagClass;
  const humanCalled=L.lastCall&&L.subDate&&(L.lastCall-L.subDate)>CALL_TOL_MS;
  if(expired){
    reason='Backlog >'+Math.round(W.expire/24)+'j';tagClass='backlog';
  }else{
    if(!humanCalled){
      parts['Jamais relancé']=W.fresh;
      if(L.ageHours<48){parts['Fenêtre 48h']=W.win48;reason='Fenêtre 48h';tagClass='win';}
      else if(L.ageHours<96){parts['Fenêtre <96h']=Math.round(W.win48*0.5);reason='Frais';tagClass='never';}
      else{reason='Jamais relancé';tagClass='never';}
    }else{
      const hSince=(Date.now()-L.lastCall)/3.6e6;
      if(hSince<48){parts['Relancé récemment']=W.recent;reason='Relancé récemment';tagClass='recent';}
      else if(hSince<120){parts['À relancer']=W.due;reason='À relancer';tagClass='due';}
      else{parts['Relance en retard']=W.overdue;reason='Relance en retard';tagClass='due';}
    }
    if(L.ageHours>W.expire-72){parts['Dernière chance']=W.last;reason='Dernière chance';tagClass='last';}
  }
  const t=sourceTier(L.source);parts['Source']=t==='hi'?W.srcHi:t==='lo'?W.srcLo:Math.round((W.srcHi+W.srcLo)/2);
  parts['Produit']=productScore(L.product);
  if(L.company&&L.company!=='-'&&L.company!=='—')parts['Déjà connu']=W.hist;
  return{score:Object.values(parts).reduce((a,b)=>a+b,0),parts,reason,tagClass,humanCalled,expired,lastChance,fresh};
}

const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtAge=h=>h<48?Math.round(h)+'h':Math.round(h/24)+'j';
const shortProd=p=>(p||'—').split(/[;,]/).map(x=>x.trim()).filter(Boolean).slice(0,2).join(' · ')||'—';
function srcBadge(src){const t=sourceTier(src);return `<span class="badge b-src ${t==='hi'?'hi':''}">${esc(src||'?')}</span>`;}
function attBadge(L){const max=W.maxCalls,done=L.nbCalls||0,rem=max-done;
  if(rem<=0)return `<span class="tag last" title="Tentatives épuisées">${done}/${max} · épuisé</span>`;
  if(rem===1)return `<span class="tag last" title="Dernière tentative avant la limite">${done}/${max} · dernier</span>`;
  return `<span class="badge b-att" title="Tentatives faites / max">${done}/${max}</span>`;}
function phoneHTML(p){if(!p)return'';const clean=p.replace(/[^\d+]/g,'');return `<span class="phone"><a href="tel:${esc(clean)}">${esc(p)}</a><span class="cp" data-ph="${esc(clean)}" title="Copier">⧉</span></span>`;}
function cpName(n){return `<span class="cpn" data-cn="${esc(n)}" title="Copier le nom pour le retrouver dans Salesforce">⧉</span>`;}

const FILTERS=[['all','Tout'],['Fenêtre 48h','48 h'],['À relancer','À relancer'],['Dernière chance','Dernière chance'],['hi','Sources chaudes']];
function passFilter(L,r){
  if(activeFilter==='all')return true;
  if(activeFilter==='hi')return sourceTier(L.source)==='hi';
  return r.reason===activeFilter;
}
function passQuery(L){if(!query)return true;const q=query.toLowerCase();return (L.name+' '+L.company+' '+L.product+' '+L.source+' '+L.biz).toLowerCase().includes(q);}

function rowHTML(L,r,rank,isCalled){
  const bd=Object.entries(r.parts).map(([k,v])=>`<span class="bd-item">${esc(k)} <b>+${v}</b></span>`).join('');
  return `<div class="row ${rank<=5&&!isCalled?'top':''} ${isCalled?'done':''}" data-id="${L.id}">
    <div class="rank">${isCalled?'✓':rank}</div>
    <div class="main">
      <div class="nm">${esc(L.name)} ${cpName(L.name)}${L.company&&L.company!=='-'&&L.company!=='—'?` <span class="co">· ${esc(L.company)}</span>`:''}</div>
      <div class="meta">
        <span class="tag ${r.tagClass}">${esc(r.reason)}</span>
        ${srcBadge(L.source)}
        <span class="badge b-prod">${esc(shortProd(L.product))}</span>
        <span class="badge b-age">${fmtAge(L.ageHours)}</span>
        ${attBadge(L)}
        ${dupSet.has(L.id)?`<span class="tag dup" title="Numéro ou nom partagé avec un autre lead">doublon ?</span>`:''}
        ${L.biz?`<span class="badge b-biz">${esc(L.biz)}</span>`:''}
      </div>
    </div>
    <div class="callbox">${phoneHTML(L.phone)}<div class="score">${r.score}</div></div>
    <button class="doneBtn" data-done="${L.id}" title="Marquer appelé (C)">${isCalled?'✓':'○'}</button>
    <div class="bd"><div class="bd-grid">${bd}</div>
      <div class="bd-note">${r.humanCalled?'Déjà appelé par toi après sa demande.':'Seul l\'appel IA a eu lieu — pas encore relancé par toi.'} Nb appels cumulés : ${L.nbCalls||0} (non compté).</div>
    </div>
  </div>`;
}

function computeDups(){
  const byPhone={},byName={},s=new Set();
  LEADS.forEach(L=>{
    const p=(L.phone||'').replace(/\D/g,'').slice(-9);
    if(p.length>=6)(byPhone[p]=byPhone[p]||[]).push(L.id);
    const n=(L.name||'').toLowerCase().replace(/\s+/g,' ').trim();
    if(n&&n!=='—')(byName[n]=byName[n]||[]).push(L.id);
  });
  Object.values(byPhone).forEach(ids=>{if(ids.length>1)ids.forEach(i=>s.add(i));});
  Object.values(byName).forEach(ids=>{if(ids.length>1)ids.forEach(i=>s.add(i));});
  return s;
}
function renderFocus(pool){
  const el=document.getElementById('focus');
  if(!focusMode){el.classList.remove('show');el.innerHTML='';return;}
  let next=pool.find(x=>!skipSet.has(x.L.id));
  if(!next&&skipSet.size){skipSet=new Set();next=pool[0];}
  if(!next){el.classList.add('show');el.innerHTML=`<div class="fc-empty">File vidée — tous les leads prioritaires sont traités.</div>`;return;}
  const {L,r}=next;const clean=(L.phone||'').replace(/[^\d+]/g,'');
  el.classList.add('show');
  el.innerHTML=`
    <div class="fc-lbl">Prochain appel · rang ${pool.indexOf(next)+1}</div>
    <div class="fc-name">${esc(L.name)} ${cpName(L.name)}${L.company&&L.company!=='-'&&L.company!=='—'?` <span>· ${esc(L.company)}</span>`:''}</div>
    <div class="fc-meta"><span class="tag ${r.tagClass}">${esc(r.reason)}</span>${srcBadge(L.source)}<span class="badge b-prod">${esc(shortProd(L.product))}</span><span class="badge b-age">${fmtAge(L.ageHours)}</span>${dupSet.has(L.id)?`<span class="tag dup">doublon ?</span>`:''}<span class="score">${r.score}</span></div>
    ${L.phone?`<a class="fc-call" href="tel:${esc(clean)}">Appeler ${esc(L.phone)}</a>`:''}
    <div class="fc-btns"><button class="btn primary" id="fcDone">Appelé — suivant</button><button class="btn" id="fcSkip">Passer</button></div>`;
  document.getElementById('fcDone').onclick=()=>toggleCalled(L.id);
  document.getElementById('fcSkip').onclick=()=>{skipSet.add(L.id);render();};
}
function renderPerf(rankMap,rdvIds){
  const el=document.getElementById('perf');
  if(!calledSet.size){el.classList.remove('show');el.innerHTML='';return;}
  const called=LEADS.filter(L=>calledSet.has(L.id));
  const srcCount={};
  called.forEach(L=>{const s=L.source||'?';srcCount[s]=(srcCount[s]||0)+1;});
  const srcHTML=Object.entries(srcCount).sort((a,b)=>b[1]-a[1])
    .map(([s,n])=>`<span class="badge b-src ${sourceTier(s)==='hi'?'hi':''}">${esc(s)} · ${n}</span>`).join('');
  // un rappel honoré n'est pas « hors liste » : c'est un engagement tenu, il a
  // sa propre catégorie plutôt que d'être compté comme un écart de priorité.
  const bk={rdv:0,t5:0,t15:0,t25:0,out:0};
  called.forEach(L=>{
    if(rdvIds&&rdvIds.has(L.id)){bk.rdv++;return;}
    const rk=rankMap.get(L.id);
    if(rk==null||rk>W.pool)bk.out++;else if(rk<=5)bk.t5++;else if(rk<=15)bk.t15++;else bk.t25++;});
  const tot=called.length;
  const seg=(n,c)=>n?`<div class="perf-seg" style="width:${(n/tot*100).toFixed(1)}%;background:${c}"></div>`:'';
  const bar=seg(bk.rdv,'var(--amber)')+seg(bk.t5,'var(--teal)')+seg(bk.t15,'#5f978e')+seg(bk.t25,'#c9c6bd')+seg(bk.out,'var(--signal)');
  el.innerHTML=`<div class="ph">Performance du jour</div>
    <div class="prow"><span class="plabel">Par source</span><div class="chips">${srcHTML}</div></div>
    <div class="prow"><span class="plabel">Priorité suivie</span><div class="perf-bar">${bar}</div></div>
    <div class="prow"><span class="plabel"></span>
      ${bk.rdv?`<span class="pcount" style="color:var(--amber)">■ Rappels · ${bk.rdv}</span>`:''}
      <span class="pcount" style="color:var(--teal)">■ Top 5 · ${bk.t5}</span>
      <span class="pcount" style="color:#5f978e">■ 6–15 · ${bk.t15}</span>
      <span class="pcount" style="color:#9a968c">■ 16–${W.pool} · ${bk.t25}</span>
      <span class="pcount" style="color:var(--signal)">■ Hors liste · ${bk.out}</span>
    </div>`;
  el.classList.add('show');
}
function tierOf(r){return r.expired?2:(r.fresh?0:1);}
function prio(a,b){
  const ta=tierOf(a.r),tb=tierOf(b.r);
  if(ta!==tb)return ta-tb;
  return (b.r.score-a.r.score)||(a.L.ageHours-b.L.ageHours)||(a.L.id-b.L.id);
}
function render(){
  const now=new Date();
  dupSet=computeDups();
  const rdv=[],scored=[];
  for(const L of LEADS){
    if(L.callback){const dh=(L.callback-now)/3.6e6;
      if(dh>-2&&dh<28){rdv.push({L,od:false});continue;}
      if(dh<=-2&&dh>-24*7){rdv.push({L,od:true});continue;}}
    scored.push({L,r:scoreLead(L)});
  }
  // tri : en mode priorité, les backlog (>14j) passent toujours APRÈS les actifs
  scored.sort((a,b)=>{
    if(sortMode==='age')return b.L.ageHours-a.L.ageHours || a.L.id-b.L.id;
    /* « demande la plus récente » : on trie sur Last Form Submission Date (subDate)
       et non sur ageHours, qui vient d'une colonne Salesforce distincte et peut
       manquer. Une demande sans date connue vaut 0 et part donc en fin de liste. */
    if(sortMode==='recent')return (b.L.subDate?+b.L.subDate:0)-(a.L.subDate?+a.L.subDate:0) || a.L.id-b.L.id;
    if(sortMode==='value')return productScore(b.L.product)-productScore(a.L.product) || b.r.score-a.r.score || a.L.id-b.L.id;
    return prio(a,b);
  });
  const rankMap=new Map([...scored].sort(prio).map((x,i)=>[x.L.id,i+1]));
  const activeCount=scored.filter(x=>!x.r.expired&&!calledSet.has(x.L.id)).length;
  const backlogCount=scored.filter(x=>x.r.expired).length;
  // vue filtrée
  const view=scored.filter(({L,r})=>passFilter(L,r)&&passQuery(L));
  const notCalled=view.filter(({L})=>!calledSet.has(L.id));
  const calledInView=view.filter(({L})=>calledSet.has(L.id));
  const pool=notCalled.slice(0,W.pool);
  renderFocus(pool);

  // stats
  document.getElementById('stats').innerHTML=`
    <div class="stat"><div class="n">${LEADS.length}</div><div class="l">leads au total</div></div>
    <div class="stat accent"><div class="n">${activeCount}</div><div class="l">actifs à appeler</div></div>
    <div class="stat"><div class="n">${rdv.length}</div><div class="l">rappels</div></div>
    <div class="stat"><div class="n">${backlogCount}</div><div class="l">backlog &gt;14j</div></div>`;

  // progression
  const restants=scored.filter(({L})=>!calledSet.has(L.id)).length
                +rdv.filter(({L})=>!calledSet.has(L.id)).length;
  const target=Math.min(W.pool,restants+calledSet.size);
  const done=calledSet.size;
  document.getElementById('progFill').style.width=(target?Math.min(100,done/target*100):0)+'%';
  document.getElementById('progLbl').innerHTML=`Appelés aujourd'hui <b>${done}</b>${target?` / ${target}`:''}`;
  renderPerf(rankMap,new Set(rdv.map(x=>x.L.id)));

  // bannière expiration
  const soon=scored.filter(({L})=>!calledSet.has(L.id)&&L.ageHours>W.expire-24&&L.ageHours<=W.expire).length;
  const b=document.getElementById('banner');
  if(soon){b.classList.add('show');document.getElementById('bannerTxt').textContent=`${soon} lead${soon>1?'s':''} expire${soon>1?'nt':''} dans moins de 24 h — dernière chance de les joindre.`;}
  else b.classList.remove('show');

  // chips
  document.getElementById('chips').innerHTML=FILTERS.map(([k,l])=>`<span class="chip ${activeFilter===k?'on':''}" data-f="${k}">${l}</span>`).join('');
  document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{activeFilter=c.dataset.f;selIdx=-1;render();});

  // RDV
  const rdvSec=document.getElementById('rdvSection');
  if(rdv.length){
    rdvSec.style.display='';
    rdv.sort((a,b)=>a.L.callback-b.L.callback);
    document.getElementById('rdvCount').textContent=rdv.length+(rdv.length>1?' engagements':' engagement');
    document.getElementById('rdvList').innerHTML=rdv.map(({L,od})=>{
      const t=L.callback.toLocaleString('fr-FR',{weekday:'short',hour:'2-digit',minute:'2-digit'});
      const fait=calledSet.has(L.id);
      return `<div class="row ${fait?'done':''}" data-id="${L.id}"><div class="rank" style="color:${fait?'var(--teal)':(od?'var(--signal)':'var(--teal)')}">${fait?'✓':'◷'}</div>
        <div class="main"><div class="nm">${esc(L.name)} ${cpName(L.name)}${L.company&&L.company!=='-'?` <span class="co">· ${esc(L.company)}</span>`:''}</div>
        <div class="meta"><span class="tag ${od?'od':'rdv'}">${od?'Rappel en retard':'Rappel convenu'}</span>${srcBadge(L.source)}<span class="badge b-prod">${esc(shortProd(L.product))}</span></div></div>
        <div class="callbox rdvbox">${phoneHTML(L.phone)}<div class="rdv-time ${od?'od':''}">${t}</div></div>
        <button class="doneBtn" data-done="${L.id}" title="Marquer appelé">${fait?'✓':'○'}</button></div>`;
    }).join('');
  }else rdvSec.style.display='none';

  // pool
  document.getElementById('poolCount').textContent=`${pool.length} affichés · ${notCalled.length} en attente`+(query||activeFilter!=='all'?' (filtré)':'');
  const list=document.getElementById('list');
  list.innerHTML=pool.length?pool.map(({L,r},i)=>rowHTML(L,r,i+1,false)).join('')
    :'<div class="empty">Rien à afficher ici. Change de filtre, ou tout est appelé 👏</div>';

  // appelés
  const cs=document.getElementById('calledSec');
  if(calledInView.length){cs.style.display='';document.getElementById('calledSummary').textContent=`Appelés (${calledInView.length})`;
    document.getElementById('calledList').innerHTML=calledInView.map(({L,r})=>rowHTML(L,r,0,true)).join('');}
  else cs.style.display='none';

  wireRows();
  applySel();
}

function wireRows(){
  document.querySelectorAll('.main').forEach(el=>el.onclick=()=>el.closest('.row').classList.toggle('open'));
  document.querySelectorAll('[data-done]').forEach(b=>b.onclick=e=>{e.stopPropagation();toggleCalled(+b.dataset.done);});
  document.querySelectorAll('.cp').forEach(c=>c.onclick=e=>{e.stopPropagation();navigator.clipboard?.writeText(c.dataset.ph);toast('Numéro copié');});
  document.querySelectorAll('.cpn').forEach(c=>c.onclick=e=>{e.stopPropagation();navigator.clipboard?.writeText(c.dataset.cn);toast('Nom copié — colle-le dans Salesforce');});
}
/* Les appels du jour sont retenus par IDENTITÉ de lead (téléphone + nom) et
   non par id interne : ils survivent ainsi à un rechargement de page comme à
   un ré-import de l'export en cours de journée. Sans ça, marquer 20 appels
   puis recharger l'export remettait le compteur à zéro et la page
   Performance sous-comptait la journée. Accès storage guardés. */
let calledKeys=new Set();
function loadCalled(){
  try{const o=JSON.parse(localStorage.getItem('calledDay'));
    if(o&&o.date===dkey(new Date())&&Array.isArray(o.keys))return new Set(o.keys);}catch(e){}
  return new Set();
}
function saveCalled(){
  try{localStorage.setItem('calledDay',JSON.stringify({date:dkey(new Date()),keys:[...calledKeys]}));}catch(e){}
}
function syncCalledFromKeys(){
  calledSet=new Set(LEADS.filter(L=>calledKeys.has(leadKey(L))).map(L=>L.id));
}
function toggleCalled(id){
  const L=LEADS.find(x=>x.id===id);if(!L)return;
  const k=leadKey(L);
  if(calledSet.has(id)){calledSet.delete(id);calledKeys.delete(k);}
  else{calledSet.add(id);calledKeys.add(k);toast('Marqué appelé');}
  saveCalled();render();commitToday();
  if(document.getElementById('pagePerf').style.display!=='none')renderPerfPage();
}

function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),1400);}

/* sélection clavier */
function poolRows(){return [...document.querySelectorAll('#list .row')];}
function applySel(){poolRows().forEach((r,i)=>r.classList.toggle('sel',i===selIdx));const r=poolRows()[selIdx];if(r)r.scrollIntoView({block:'nearest'});}
document.addEventListener('keydown',e=>{
  if(/input|textarea|select/i.test(e.target.tagName))return;
  if(!document.getElementById('mapper').hidden)return;   // modale ouverte : on ne touche pas à la file
  if(focusMode){const d=document.getElementById('fcDone'),s=document.getElementById('fcSkip');
    if((e.key==='c'||e.key==='Enter')&&d){e.preventDefault();d.click();return;}
    if(e.key==='s'&&s){e.preventDefault();s.click();return;}}
  const rows=poolRows();if(!rows.length&&e.key!=='/')return;
  if(e.key==='j'||e.key==='ArrowDown'){e.preventDefault();selIdx=Math.min(rows.length-1,selIdx+1);applySel();}
  else if(e.key==='k'||e.key==='ArrowUp'){e.preventDefault();selIdx=Math.max(0,selIdx-1);applySel();}
  else if(e.key==='Enter'&&rows[selIdx]){e.preventDefault();rows[selIdx].classList.toggle('open');}
  else if(e.key==='c'&&rows[selIdx]){e.preventDefault();toggleCalled(+rows[selIdx].dataset.id);}
  else if(e.key==='/'){e.preventDefault();document.getElementById('search').focus();}
});

/* export */
function exportCSV(){
  const now=new Date();const rows=[];
  for(const L of LEADS){if(L.callback){const dh=(L.callback-now)/3.6e6;if(dh>-24*7&&dh<28)continue;}const r=scoreLead(L);if(calledSet.has(L.id))continue;if(!passFilter(L,r)||!passQuery(L))continue;rows.push({L,r});}
  rows.sort(prio);
  const top=rows.slice(0,W.pool);
  const head=['Rang','Nom','Entreprise','Téléphone','Produit','Source','Âge (h)','Raison','Score'];
  const lines=[head.join(';')].concat(top.map((x,i)=>[i+1,x.L.name,x.L.company,x.L.phone,x.L.product,x.L.source,Math.round(x.L.ageHours),x.r.reason,x.r.score].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(';')));
  const blob=new Blob(['\ufeff'+lines.join('\n')],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='file-appels-'+now.toISOString().slice(0,10)+'.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Liste exportée');
}

/* démo */
function fmtDE(d){const p=n=>String(n).padStart(2,'0');return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;}
function demoData(){
  _id=0;const now=Date.now(),H=3.6e6;const rows=[];
  const sources=['facebook','facebook','facebook','facebook','organic','google-sea','hipto','referral','facebook','organic'];
  const prods=['POS Plus','SumUp Kiosk;POS Plus','Terminal','POS Pro;POS Plus','Payment','SumUp Kiosk;Payment;POS Plus','POS Plus','Terminal','SumUp Kiosk','POS Plus'];
  const biz=['other','fast food','restaurant','bar','tearoom','regular','other','restaurant'];
  const firsts=['Anne-Marie','Kevin','Smaïl','Madmax','Lorenzo','Redouane','Jean-Luc','Gabin','Philippe','Amina','Aliénor','David','Ayşegül','Serkan','Juliette','Karim','Sophie','Marco','Nadia','Thomas','Émilie','Yanis','Claire','Hugo','Farida','Lucas','Inès','Bilal','Océane','Raphaël','Leïla','Antoine','Manon','Ferhat','Chloé','Diego','Sarah','Malik','Camille','Enzo','Fatou','Julien','Léa','Omar','Zoé','Paul'];
  const last=['Dupont','Poit','Moukhtar','Moha','Laurent','Fassi','Vallée','Gourdet','Cogez','France','Bonvin','Bellec','Aydın','Geçtili','Charrier'];
  const cos={3:'Rôtisserie du Coin',5:'FARIH',7:'Café des Sports',8:'Cogez SARL',14:'Charrier Traiteur',20:'Le Bistrot',26:'Pizza Napoli',33:'Green Coffee'};
  const N=46;
  for(let i=0;i<N;i++){
    const age=i<14?2+i*3:(i<30?44+(i-14)*11:250+(i-30)*15);
    const sub=new Date(now-age*H);let call=new Date(sub);
    if(i%9===0)call=new Date(sub.getTime()+(2+(i%6))*H);
    else if(i%9===3){call=new Date(sub.getTime()+1*H);if(age>140)call=new Date(now-8*H);}
    // plage 06 39 98 XX XX, réservée à la fiction : aucun risque d'appeler
    // quelqu'un par erreur si l'outil est ouvert sans avoir chargé l'export.
    const ph='+33 6 39 98 '+String(10+i).padStart(2,'0')+' '+String(10+(i*7)%90).padStart(2,'0');
    rows.push({Name:firsts[i%firsts.length]+' '+last[i%15],Company:cos[i]||'-',Phone:ph,'Prospect product interest':prods[i%prods.length],'Lead age (hours)':age.toFixed(2).replace('.',','),'GA Source':sources[i%sources.length],'Business type':biz[i%biz.length],'Last Form Submission Date':fmtDE(sub),'Last Outbound Call Date':fmtDE(call),'Nb Of Outbound Calls':(i===12?26:(i%9===0?2:1)),'Call back date':''});
  }
  rows[1]['Call back date']=fmtDE(new Date(now+2*H));
  rows[5]['Call back date']=fmtDE(new Date(now+5*H));
  rows[9]['Call back date']=fmtDE(new Date(now-4*H)); // rappel en retard
  rows[12]['Call back date']=fmtDE(new Date(2024,6,10,16,30));
  rows[22]['Phone']=rows[4]['Phone'];rows[22]['Name']=rows[4]['Name']; // doublon : même personne, re-soumission
  return rows.map(mapRow);
}

/* réglages */
const CTRLS=[['pool','s_pool','v_pool'],['expire','s_expire','v_expire'],['maxCalls','s_maxcalls','v_maxcalls'],['fresh','s_fresh','v_fresh'],['win48','s_win48','v_win48'],['recent','s_recent','v_recent'],['due','s_due','v_due'],['overdue','s_overdue','v_overdue'],['last','s_last','v_last'],['srcHi','s_srcHi','v_srcHi'],['srcLo','s_srcLo','v_srcLo'],['prodHi','s_prodHi','v_prodHi'],['prodLo','s_prodLo','v_prodLo'],['combo','s_combo','v_combo'],['hist','s_hist','v_hist']];
function syncCtrls(){CTRLS.forEach(([k,s,v])=>{document.getElementById(s).value=W[k];document.getElementById(v).textContent=W[k];});document.getElementById('poolLabel').textContent=W.pool;}
CTRLS.forEach(([k,s,v])=>document.getElementById(s).addEventListener('input',e=>{W[k]=+e.target.value;document.getElementById(v).textContent=W[k];if(k==='pool')document.getElementById('poolLabel').textContent=W[k];render();}));
document.getElementById('resetBtn').onclick=()=>{W={...DEFAULTS};syncCtrls();render();};

/* ===== Import : CSV ou PDF « Printable View » =====
   Les deux chemins convergent sur ingestRows() : détection souple des colonnes,
   écran de correspondance si ça ne suffit pas, puis mapRow(). */
let lastImport=null;    // import APPLIQUÉ (celui qui alimente LEADS)
let pendingImport=null; // import en attente de correspondance des colonnes

function headersOf(rows){
  const out=[];
  rows.forEach(r=>Object.keys(r).forEach(k=>{if(k&&!out.includes(k))out.push(k);}));
  return out;
}
const txt=v=>String(v==null?'':v).replace(/\s+/g,' ').trim();
function firstValue(rows,header){
  if(!header)return'';
  for(const r of rows){const v=txt(r[header]);if(v)return v;}
  return'';
}

function ingestRows(rows,label,kind,warnings){
  rows=(rows||[]).filter(r=>r&&Object.values(r).some(v=>txt(v)));
  if(!rows.length){alert('Aucune ligne exploitable dans ce fichier.');return;}
  const headers=headersOf(rows);
  missingDismissed='';                              // nouveau fichier = on re-signale ce qui manque
  pendingImport={rows,headers,label,kind,warnings:warnings||[]};
  const map=LeadColumns.autoMap(headers);
  const missing=LeadColumns.missingRequired(map);
  if(missing.length)openMapper(map,missing);      // détection insuffisante
  else applyMapping(map);
}

/* map : {colonne canonique -> en-tête du fichier}
   `restoring` : on rejoue un fichier relu du navigateur au démarrage — on ne le
   ré-enregistre pas, sinon la péremption 24 h repartirait à zéro à chaque
   rafraîchissement et le fichier ne s'effacerait jamais. */
function applyMapping(map,restoring){
  if(!pendingImport)return;
  const{rows}=pendingImport;
  pendingImport.map=map;
  lastImport=pendingImport;
  const norm=rows.map(r=>{
    const o={};
    LeadColumns.COLUMNS.forEach(c=>{const src=map[c.key];o[c.key]=src?txt(r[src]):'';});
    return o;
  });
  skipSet=new Set();
  LEADS=norm.map(mapRow);
  syncCalledFromKeys();          // les appels du jour suivent les leads, pas les ids
  selIdx=-1;
  if(!restoring)saveImport();
  showSource();
  render();
}

/* ===== Le fichier chargé survit à un rafraîchissement (24 h) =====
   `perfHistory` et les appels du jour (`calledDay`) étaient déjà persistés,
   mais PAS l'export lui-même : au rechargement on repartait sur les données de
   démonstration, et comme `syncCalledFromKeys` ne retrouvait plus aucun lead,
   la barre « Appelés aujourd'hui » retombait à 0/25 alors que la page
   Performance, elle, comptait juste. On garde donc le fichier tel qu'il est
   arrivé (lignes brutes + correspondance des colonnes), ce qui préserve aussi
   « Corriger les colonnes » et « Télécharger le CSV » après un rechargement.

   Ça reste 100 % local — rien ne part vers un serveur, le garde-fou du projet
   tient — mais ce sont bien des données leads écrites sur le disque du poste :
   d'où la péremption à 24 h et le bouton « Oublier ce fichier ». */
const SNAP_KEY='lastImport';
const SNAP_TTL=24*3600*1000;                 // 24 h pile, comme demandé
const SNAP_MAX=3.5e6;                        // ~3,5 Mo : au-delà on renonce plutôt que de faire sauter le quota
function saveImport(){
  if(!lastImport)return;
  try{
    const{label,kind,headers,rows,map,warnings}=lastImport;
    const payload=JSON.stringify({savedAt:Date.now(),label,kind,headers,rows,map,warnings:warnings||[]});
    if(payload.length>SNAP_MAX){localStorage.removeItem(SNAP_KEY);return;}   // export énorme : on ne persiste pas
    localStorage.setItem(SNAP_KEY,payload);
  }catch(e){}                                // storage plein ou bloqué : on retombe simplement sur la démo
}
function loadImport(){
  try{
    const s=localStorage.getItem(SNAP_KEY);
    if(!s)return null;
    const o=JSON.parse(s);
    if(!o||!Array.isArray(o.rows)||!o.rows.length||!o.map||!o.savedAt)return null;
    if(Date.now()-o.savedAt>=SNAP_TTL){localStorage.removeItem(SNAP_KEY);return null;}   // périmé : on efface
    return o;
  }catch(e){return null;}
}
function restoreImport(){
  const o=loadImport();
  if(!o)return false;
  pendingImport={rows:o.rows,headers:o.headers||headersOf(o.rows),label:o.label,kind:o.kind,
    warnings:o.warnings||[],savedAt:o.savedAt,restored:true};
  applyMapping(o.map,true);
  return true;
}
/* Efface du navigateur tout ce qui touche aux leads : le fichier ET les appels
   du jour (qui portent téléphone + nom). L'historique de performance, lui, est
   agrégé et anonyme — on n'y touche pas. */
function forgetImport(){
  try{localStorage.removeItem(SNAP_KEY);localStorage.removeItem('calledDay');}catch(e){}
  lastImport=null;pendingImport=null;
  calledKeys=new Set();calledSet=new Set();skipSet=new Set();selIdx=-1;
  LEADS=demoData();
  showSource();render();
  toast('Fichier oublié — retour aux données de démonstration');
}
const agoTxt=ms=>{const h=Math.floor(ms/3.6e6);if(h<1)return"il y a moins d'une heure";return h===1?'il y a 1 h':`il y a ${h} h`;};

function showSource(){
  const el=document.getElementById('datasource');
  const demo=document.getElementById('demoBanner');
  if(demo)demo.hidden=!!lastImport;
  if(!lastImport){
    el.textContent="Données de démonstration — dépose ton export CSV ou ton PDF Printable View pour passer sur tes vrais leads";
    renderMissingCols(null);
    return;
  }
  const{label,kind,warnings,map,restored,savedAt}=lastImport;
  el.innerHTML=`<b>${esc(label)}</b> — ${LEADS.length} leads chargés`
    +(kind==='pdf'?' · <span title="Conversion faite dans ton navigateur, le PDF n\'est envoyé nulle part">PDF converti en local</span>':'')
    +(restored&&savedAt?` · <span title="Relu depuis ce navigateur, il n'a jamais quitté ton poste. Effacé automatiquement 24 h après le chargement.">repris de ce navigateur, chargé ${esc(agoTxt(Date.now()-savedAt))}</span>`:'')
    +`<span class="dslinks">`
    +(kind==='pdf'?`<button class="lnk" id="dlCsvBtn" title="Récupérer le CSV issu du PDF">Télécharger le CSV</button>`:'')
    +`<button class="lnk" id="remapBtn">Corriger les colonnes</button>`
    +`<button class="lnk" id="forgetBtn" title="Efface de ce navigateur le fichier et les appels marqués aujourd'hui">Oublier ce fichier</button></span>`
    +(warnings&&warnings.length?`<div class="dswarn">${warnings.map(esc).join('<br>')}</div>`:'');
  const dl=document.getElementById('dlCsvBtn');if(dl)dl.onclick=downloadConvertedCSV;
  const rm=document.getElementById('remapBtn');if(rm)rm.onclick=openRemap;
  const fg=document.getElementById('forgetBtn');if(fg)fg.onclick=forgetImport;
  renderMissingCols(map||{},true);                  // le détail des colonnes absentes vit dans son panneau
}
function openRemap(){
  if(!lastImport)return;
  pendingImport=lastImport;                         // on re-corrige le fichier déjà chargé
  openMapper(lastImport.map||LeadColumns.autoMap(lastImport.headers),[]);
}

/* --- Colonnes manquantes : ce qu'il faut ajouter à l'export Salesforce ---
   L'ordre des colonnes n'a aucune importance (elles sont reconnues par leur
   NOM, cf. LeadColumns.autoMap) ; leur ABSENCE, si. On nomme donc chaque
   colonne manquante par son intitulé Salesforce exact, on dit ce qu'elle
   pilote, et on rappelle qu'il faut la rajouter à la vue liste avant de
   ré-exporter. Le panneau est masquable : un export volontairement partiel ne
   doit pas harceler. */
let missingDismissed='';
function renderMissingCols(map,allowRemap){
  const box=document.getElementById('missingCols');
  if(!box)return;
  if(!map){box.hidden=true;box.innerHTML='';return;}
  const rep=LeadColumns.missingReport(map);
  const sign=[...rep.required,...rep.important].map(c=>c.key).join('|');
  if(!rep.any||sign===missingDismissed){box.hidden=true;box.innerHTML='';return;}
  const manquantes=[...rep.required,...rep.important];
  const li=c=>`<li><code>${esc(c.key)}</code><span class="mcuse">${esc(c.label)} — ${esc(c.use)}</span></li>`;
  box.className='misscols'+(rep.blocking?' blocking':'');
  box.innerHTML=`<div class="mchead">
      <span class="dot"></span>
      <b>${manquantes.length===1?'Une colonne manquante':manquantes.length+' colonnes manquantes'} dans ton export Salesforce</b>
      <button class="lnk mcclose" id="mcDismiss" title="Masquer jusqu'au prochain import">Masquer</button>
    </div>
    <p class="mctxt">${rep.blocking
      ? "Sans ces colonnes, la file d'appels ne peut pas être construite."
      : "L'outil fonctionne quand même, mais ces colonnes entrent dans le score : sans elles, la priorisation est dégradée."}
      Ajoute-les à ta vue liste Salesforce (<i>Modifier la vue → Sélectionner les champs à afficher</i>), puis relance l'export.
      Leur ordre dans l'export n'a aucune importance.</p>
    <div class="mcsub">Nom exact de la colonne à ajouter dans Salesforce :</div>
    <ul class="mclist">${manquantes.map(li).join('')}</ul>
    ${rep.optional.length?`<p class="mcopt">Facultatives, également absentes : ${rep.optional.map(c=>`<code>${esc(c.key)}</code>`).join(', ')} — affichage seulement, aucun effet sur le tri.</p>`:''}
    ${allowRemap?`<p class="mcfoot">Ces colonnes sont bien dans ton export mais sous un autre intitulé ? <button class="lnk" id="remapBtn2">Corriger les colonnes à la main</button></p>`:''}`;
  box.hidden=false;
  const d=document.getElementById('mcDismiss');
  if(d)d.onclick=()=>{missingDismissed=sign;renderMissingCols(map,allowRemap);};
  const r=document.getElementById('remapBtn2');
  if(r)r.onclick=openRemap;
}

/* Le CSV issu du PDF : ce que produisait le convertisseur tiers, en local. */
function downloadConvertedCSV(){
  if(!lastImport)return;
  const csv=PdfCsv.toCSV(lastImport.headers,lastImport.rows);
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=lastImport.label.replace(/\.pdf$/i,'')+'.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('CSV téléchargé');
}

/* --- écran de correspondance des colonnes --- */
function openMapper(map,missing){
  if(!pendingImport)return;
  const{rows,headers}=pendingImport;
  const box=document.getElementById('mapRows');
  box.innerHTML=LeadColumns.COLUMNS.filter(c=>c.req!=='derive').map(c=>{
    const opts=['<option value="">— absente —</option>'].concat(
      headers.map(h=>`<option value="${esc(h)}"${map[c.key]===h?' selected':''}>${esc(h)}</option>`)).join('');
    const req=c.req==='essentiel'?'<span class="mreq">obligatoire</span>':(c.req==='important'?'<span class="mimp">compte dans le score</span>':'');
    return `<div class="maprow" data-key="${esc(c.key)}">
      <div class="mlabel"><b>${esc(c.label)}</b> ${req}<div class="mkey">${esc(c.key)}</div></div>
      <select class="msel" data-key="${esc(c.key)}">${opts}</select>
      <div class="mprev" data-prev="${esc(c.key)}">${esc(firstValue(rows,map[c.key])||'—')}</div>
    </div>`;
  }).join('');
  const msg=document.getElementById('mapMsg');
  msg.innerHTML=missing&&missing.length
    ?`Détection automatique incomplète : ${missing.map(k=>`<code>${esc(k)}</code>`).join(', ')} ${missing.length>1?'n\'ont pas été trouvées':'n\'a pas été trouvée'} dans le fichier. Indique la colonne correspondante ci-dessous, ou ajoute-la à ton export Salesforce.`
    :"Vérifie ou corrige les colonnes détectées. Les colonnes sont reconnues par leur nom, leur ordre dans le fichier n'a pas d'importance. L'aperçu montre la première valeur de la colonne choisie.";
  box.querySelectorAll('.msel').forEach(sel=>sel.onchange=()=>{
    box.querySelector(`[data-prev="${CSS.escape(sel.dataset.key)}"]`).textContent=firstValue(rows,sel.value)||'—';
    validateMapper();
  });
  document.getElementById('mapper').hidden=false;
  validateMapper();
}
function readMapper(){
  const map={};
  document.querySelectorAll('#mapRows .msel').forEach(sel=>{if(sel.value)map[sel.dataset.key]=sel.value;});
  return map;
}
function validateMapper(){
  const missing=LeadColumns.missingRequired(readMapper());
  const ok=document.getElementById('mapOk');
  ok.disabled=missing.length>0;
  document.getElementById('mapHint').textContent=missing.length
    ?'Colonnes obligatoires manquantes : '+missing.join(' · ')
    :'';
}
function closeMapper(){document.getElementById('mapper').hidden=true;}
document.getElementById('mapOk').onclick=()=>{applyMapping(readMapper());closeMapper();toast('Colonnes appliquées');};
document.getElementById('mapCancel').onclick=()=>{
  const abandoned=pendingImport&&pendingImport!==lastImport;
  const left=abandoned?readMapper():null;           // l'état des selects au moment où l'on abandonne
  closeMapper();
  pendingImport=lastImport;
  showSource();                                     // revient au fichier réellement chargé
  if(abandoned){
    toast('Import annulé');
    /* Abandonner sur des colonnes obligatoires introuvables, c'est le cas où
       l'utilisateur a le plus besoin de savoir quoi ajouter à son export. */
    if(LeadColumns.missingRequired(left).length)renderMissingCols(left,false);
  }
};
document.getElementById('mapper').onclick=e=>{if(e.target.id==='mapper')closeMapper();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.getElementById('mapper').hidden)closeMapper();});

/* --- CSV --- */
function loadCSV(file){
  if(typeof Papa==='undefined'){alert("Le parseur CSV n'a pas pu être chargé (vendor/papaparse.min.js). Recharge la page.");return;}
  Papa.parse(file,{header:true,skipEmptyLines:true,delimiter:'',complete:res=>{
    const rows=res.data.filter(r=>Object.keys(r).length>1);
    if(!rows.length){alert('CSV vide ou illisible.');return;}
    ingestRows(rows,file.name,'csv',[]);
  }});
}

/* --- PDF Printable View --- */
async function loadPDF(file){
  const el=document.getElementById('datasource');
  el.textContent='Lecture du PDF…';
  try{
    const{headers,rows,warnings}=await PdfCsv.convert(file,(p,n)=>{el.textContent=`Lecture du PDF… page ${p}/${n}`;});
    if(!rows.length)throw new Error("Aucun lead trouvé dans ce PDF. Si la mise en page est inhabituelle, exporte en CSV ou corrige les colonnes à la main.");
    ingestRows(rows,file.name,'pdf',warnings);
    toast(`${rows.length} leads extraits du PDF`);
  }catch(err){
    el.textContent='Échec de la lecture du PDF.';
    alert(err&&err.message?err.message:'PDF illisible.');
    showSource();
  }
}
function loadFile(file){
  if(!file)return;
  if(/\.pdf$/i.test(file.name)||file.type==='application/pdf')loadPDF(file);
  else loadCSV(file);
}
document.getElementById('csvBtn').onclick=()=>document.getElementById('csvInput').click();
document.getElementById('csvInput').onchange=e=>{if(e.target.files[0])loadCSV(e.target.files[0]);e.target.value='';};
document.getElementById('pdfBtn').onclick=()=>document.getElementById('pdfInput').click();
document.getElementById('pdfInput').onchange=e=>{if(e.target.files[0])loadPDF(e.target.files[0]);e.target.value='';};

document.getElementById('search').addEventListener('input',e=>{query=e.target.value;selIdx=-1;render();});
document.getElementById('sort').addEventListener('change',e=>{sortMode=e.target.value;render();});
document.getElementById('exportBtn').onclick=exportCSV;
document.getElementById('focusBtn').onclick=()=>{focusMode=!focusMode;const b=document.getElementById('focusBtn');b.classList.toggle('primary',focusMode);b.textContent=focusMode?'Quitter le focus':'Mode focus';skipSet=new Set();render();};
const drop=document.getElementById('drop');
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)loadFile(f);});

/* ===== Page Performance ===== */
let perfMode='day', perfHistory={};
function dkey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function loadHistory(){try{const s=localStorage.getItem('perfHistory');if(s)perfHistory=JSON.parse(s);}catch(e){} if(!Object.keys(perfHistory).length)seedHistory();}
function saveHistory(){try{localStorage.setItem('perfHistory',JSON.stringify(perfHistory));}catch(e){}}
function seedHistory(){const t=new Date();for(let i=1;i<=27;i++){const d=new Date(t);d.setDate(d.getDate()-i);const wd=d.getDay();const we=(wd===0||wd===6);const calls=we?4+Math.floor(Math.random()*6):15+Math.floor(Math.random()*13);const backlog=Math.floor(calls*(0.08+Math.random()*0.22));perfHistory[dkey(d)]={calls,active:calls-backlog,backlog,demo:true};}}
function todayStats(){let active=0,backlog=0;LEADS.forEach(L=>{if(calledSet.has(L.id)){(L.ageHours>W.expire?backlog++:active++);}});return{calls:active+backlog,active,backlog};}
/* Ce que l'on sait de la journée : les appels marqués dans cette session, ou
   le total déjà enregistré s'il est plus élevé. Sans ça, après un
   rechargement (calledSet repart à zéro) le KPI affichait 0 alors que la
   courbe, elle, montrait le total conservé. */
function todayView(){
  const t=todayStats(),p=perfHistory[dkey(new Date())];
  return(p&&p.calls>t.calls)?{calls:p.calls,active:p.active|0,backlog:p.backlog|0}:t;
}
function commitToday(){const t=todayStats();const k=dkey(new Date());const p=perfHistory[k];if(!p||t.calls>=p.calls)perfHistory[k]=t;saveHistory();}
function callsOn(d){const k=dkey(d);if(k===dkey(new Date())){const t=todayStats();const p=perfHistory[k];return Math.max(t.calls,p?p.calls:0);}return perfHistory[k]?perfHistory[k].calls:0;}
function mondayOf(d){const x=new Date(d);const off=(x.getDay()+6)%7;x.setDate(x.getDate()-off);x.setHours(0,0,0,0);return x;}

function svgLine(labels,series){
  const Wd=680,Hd=230,pL=30,pR=12,pT=12,pB=28;
  const vals=series.flatMap(s=>s.values.filter(v=>v!=null));
  const max=Math.max(8,Math.ceil((Math.max(...vals,0)*1.12)/5)*5);
  const X=i=>pL+(labels.length<2?0:i/(labels.length-1)*(Wd-pL-pR));
  const Y=v=>Hd-pB-(v/max)*(Hd-pT-pB);
  let g='';
  for(let k=0;k<=4;k++){const gv=max*k/4,gy=Y(gv);g+=`<line x1="${pL}" y1="${gy.toFixed(1)}" x2="${Wd-pR}" y2="${gy.toFixed(1)}" stroke="#EEEDE8"/><text x="${pL-6}" y="${(gy+3).toFixed(1)}" text-anchor="end" font-size="10" fill="#9a968c">${Math.round(gv)}</text>`;}
  let xl='';const step=Math.max(1,Math.ceil(labels.length/8));
  labels.forEach((lb,i)=>{if(i%step===0||i===labels.length-1)xl+=`<text x="${X(i).toFixed(1)}" y="${Hd-8}" text-anchor="middle" font-size="10" fill="#9a968c">${lb}</text>`;});
  let paths='';
  series.forEach(s=>{let d='',started=false;
    s.values.forEach((v,i)=>{if(v==null){started=false;return;}d+=(started?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' ';started=true;});
    paths+=`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-dasharray="${s.dash?'5 4':'none'}" stroke-linejoin="round"/>`;
    s.values.forEach((v,i)=>{if(v!=null)paths+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.6" fill="${s.color}"/>`;});
  });
  return `<svg viewBox="0 0 ${Wd} ${Hd}" xmlns="http://www.w3.org/2000/svg">${g}${paths}${xl}</svg>`;
}
function kdDelta(v,label,pct){const cls=v>0?'up':v<0?'down':'flat';return `<div class="kd ${cls}">${v>0?'+':''}${v}${pct?'%':''} ${label}</div>`;}
function kpis(arr){document.getElementById('perfKpis').innerHTML=arr.map(([l,n,d])=>`<div class="kpi"><div class="kn">${n}</div><div class="kl">${l}</div>${d||''}</div>`).join('');}
function renderPerfPage(){
  document.querySelectorAll('.segbtn').forEach(b=>b.classList.toggle('on',b.dataset.perf===perfMode));
  const t=new Date(), today=new Date(t.getFullYear(),t.getMonth(),t.getDate());
  if(perfMode==='day'){
    const N=14,labels=[],vals=[];
    for(let i=N-1;i>=0;i--){const d=new Date(t);d.setDate(d.getDate()-i);labels.push(`${d.getDate()}/${d.getMonth()+1}`);vals.push(callsOn(d));}
    const avg=vals.map((_,i)=>{const s=vals.slice(Math.max(0,i-6),i+1);return Math.round(s.reduce((a,b)=>a+b,0)/s.length);});
    const ts=todayView();
    const prev7=vals.slice(-8,-1);const mean7=prev7.length?Math.round(prev7.reduce((a,b)=>a+b,0)/prev7.length):0;
    document.getElementById('chartTitle').textContent='Appels par jour · 14 derniers jours';
    document.getElementById('chartLegend').innerHTML='<span><i style="border-color:#181B1E"></i>Appels/jour</span><span><i style="border-color:#B99A5B;border-top-style:dashed"></i>Moyenne 7j</span>';
    document.getElementById('chartBox').innerHTML=svgLine(labels,[{color:'#181B1E',values:vals},{color:'#B99A5B',values:avg,dash:true}]);
    kpis([['Appels aujourd\'hui',ts.calls,kdDelta(ts.calls-mean7,'vs moy. 7j')],['Dont actifs',ts.active,''],['Dont backlog',ts.backlog,''],['Moyenne 7 jours',mean7,'<div class="kd flat">appels/jour</div>']]);
  } else {
    const days=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
    const mThis=mondayOf(t),mLast=new Date(mThis);mLast.setDate(mLast.getDate()-7);
    const thisW=[],lastW=[];
    for(let i=0;i<7;i++){const d1=new Date(mThis);d1.setDate(d1.getDate()+i);const d2=new Date(mLast);d2.setDate(d2.getDate()+i);
      thisW.push(d1<=today?callsOn(d1):null);lastW.push(callsOn(d2));}
    const sumT=thisW.reduce((a,b)=>a+(b||0),0),sumL=lastW.reduce((a,b)=>a+(b||0),0);
    const elapsed=thisW.filter(v=>v!=null).length||1;
    const pct=sumL?Math.round((sumT-sumL)/sumL*100):0;
    const best=Math.max(0,...thisW.filter(v=>v!=null));
    document.getElementById('chartTitle').textContent='Cette semaine vs semaine dernière';
    document.getElementById('chartLegend').innerHTML='<span><i style="border-color:#0E7C6B"></i>Cette semaine</span><span><i style="border-color:#c9c6bd"></i>Semaine dernière</span>';
    document.getElementById('chartBox').innerHTML=svgLine(days,[{color:'#c9c6bd',values:lastW},{color:'#0E7C6B',values:thisW}]);
    kpis([['Appels cette sem.',sumT,kdDelta(pct,'vs sem. dernière',true)],['Semaine dernière',sumL,'<div class="kd flat">total</div>'],['Moyenne/jour',Math.round(sumT/elapsed),'<div class="kd flat">jours écoulés</div>'],['Meilleur jour',best,'<div class="kd flat">appels</div>']]);
  }
}
document.querySelectorAll('.tab').forEach(tb=>tb.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===tb));
  const p=tb.dataset.page;
  document.getElementById('pageCalls').style.display=p==='calls'?'':'none';
  document.getElementById('pagePerf').style.display=p==='perf'?'':'none';
  if(p==='perf')renderPerfPage();
});
document.querySelectorAll('.segbtn').forEach(b=>b.onclick=()=>{perfMode=b.dataset.perf;renderPerfPage();});

/* ===== Sauvegarde / restauration de l'historique =====
   localStorage est lié à un navigateur : ces deux boutons sont le filet de
   sécurité (cache vidé, nouveau poste). Rien ne part vers un serveur. */
const HIST_VERSION=1;
function sanitizeDay(v){
  if(!v||typeof v!=='object')return null;
  const n=x=>{const p=Number(x);return Number.isFinite(p)&&p>0?Math.round(p):0;};
  const calls=n(v.calls);
  let active=n(v.active),backlog=n(v.backlog);
  if(active+backlog!==calls){ // tolérant : on recale sans perdre le total
    active=Math.min(active,calls);
    backlog=Math.max(0,calls-active);
  }
  const day={calls,active,backlog};
  if(v.demo)day.demo=true;
  return day;
}
function exportHistory(){
  commitToday();
  const payload={app:'file-appels-leads',version:HIST_VERSION,exportedAt:new Date().toISOString(),weights:{...W},perfHistory};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='historique-file-appels-'+dkey(new Date())+'.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Historique exporté');
}
/* fusion par date : on n'écrase jamais bêtement.
   Le réel bat toujours la démo ; à statut égal, la journée la plus fournie gagne. */
function mergeHistory(incoming){
  let added=0,updated=0;
  Object.entries(incoming||{}).forEach(([k,v])=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(k))return;
    const day=sanitizeDay(v);if(!day)return;
    const cur=perfHistory[k];
    let take;
    if(!cur)take=true;
    else if(!!cur.demo!==!!day.demo)take=!!cur.demo;
    else take=day.calls>cur.calls;
    if(take){perfHistory[k]=day;cur?updated++:added++;}
  });
  return{added,updated};
}
function importHistory(file){
  const fr=new FileReader();
  fr.onerror=()=>alert('Impossible de lire ce fichier.');
  fr.onload=()=>{
    let data;
    try{data=JSON.parse(fr.result);}catch(e){alert("Fichier illisible : ce n'est pas du JSON valide.");return;}
    const hist=(data&&typeof data==='object')?(data.perfHistory||(data.version?null:data)):null;
    if(!hist||typeof hist!=='object'){alert("Aucun historique trouvé dans ce fichier.");return;}
    const{added,updated}=mergeHistory(hist);
    let wMsg='';
    if(data.weights&&typeof data.weights==='object'){
      Object.keys(DEFAULTS).forEach(k=>{const v=Number(data.weights[k]);if(Number.isFinite(v))W[k]=v;});
      syncCtrls();wMsg=' · pondérations restaurées';
    }
    saveHistory();render();
    if(document.getElementById('pagePerf').style.display!=='none')renderPerfPage();
    toast(`Historique fusionné : ${added} jour${added>1?'s':''} ajouté${added>1?'s':''}, ${updated} mis à jour${wMsg}`);
  };
  fr.readAsText(file);
}
document.getElementById('histExportBtn').onclick=exportHistory;
document.getElementById('histImportBtn').onclick=()=>document.getElementById('histInput').click();
document.getElementById('histInput').onchange=e=>{if(e.target.files[0]){importHistory(e.target.files[0]);e.target.value='';}};

loadHistory();
syncCtrls();
calledKeys=loadCalled();                     // AVANT la restauration : applyMapping s'en sert
if(!restoreImport())LEADS=demoData();        // fichier de moins de 24 h ? on le reprend
syncCalledFromKeys();
showSource();render();commitToday();
