let boot;

const db = env => env.DB || env.db;

const J = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=UTF-8',
    'cache-control': 'no-store'
  }
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="108" fill="#eaf2ff"/><path d="M72 142c0-22 18-40 40-40h254v76h42c13 0 25 6 32 17l43 65c5 7 7 15 7 24v58h-38a66 66 0 0 0-128 0H214a66 66 0 0 0-128 0H46V182c0-22 18-40 40-40z" fill="#1677e8"/><path d="M366 246h39l38 58h-77z" fill="#dbeafe"/><circle cx="150" cy="388" r="46" fill="#172033"/><circle cx="150" cy="388" r="20" fill="#fff"/><circle cx="388" cy="388" r="46" fill="#172033"/><circle cx="388" cy="388" r="20" fill="#fff"/><path d="M104 176h190v86H104z" fill="#fff" opacity=".92"/><path d="M134 198h130v18H134zm0 32h92v18h-92z" fill="#1677e8"/></svg>`;
const SW = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(fetch(e.request)))`;

async function init(env) {
  const D = db(env);
  if (!D) throw new Error('Falta vinculación D1 llamada DB');
  if (boot) return boot;

  boot = (async () => {
    await D.batch([
      D.prepare("CREATE TABLE IF NOT EXISTS productos(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT NOT NULL UNIQUE)"),
      D.prepare("CREATE TABLE IF NOT EXISTS filas(fila INTEGER PRIMARY KEY,sector TEXT NOT NULL,producto TEXT NOT NULL DEFAULT 'Soja',sentido TEXT NOT NULL DEFAULT 'derecha')"),
      D.prepare("CREATE TABLE IF NOT EXISTS lugares(fila INTEGER NOT NULL,posicion INTEGER NOT NULL,ocupado INTEGER NOT NULL DEFAULT 0,operador TEXT,PRIMARY KEY(fila,posicion))"),
      D.prepare("CREATE TABLE IF NOT EXISTS movimientos(id INTEGER PRIMARY KEY AUTOINCREMENT,fila INTEGER NOT NULL,posicion INTEGER,accion TEXT NOT NULL,operador TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP)"),
      D.prepare("CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1)")
    ]);

    const cols = await D.prepare('PRAGMA table_info(lugares)').all();
    if (!cols.results.some(c => c.name === 'bloqueado')) {
      await D.prepare('ALTER TABLE lugares ADD COLUMN bloqueado INTEGER NOT NULL DEFAULT 0').run();
    }

    const filasCols = await D.prepare('PRAGMA table_info(filas)').all();
    if (!filasCols.results.some(c => c.name === 'producto_vence_en')) {
      await D.prepare('ALTER TABLE filas ADD COLUMN producto_vence_en INTEGER').run();
    }
    if (!filasCols.results.some(c => c.name === 'activada_en')) {
      await D.prepare('ALTER TABLE filas ADD COLUMN activada_en INTEGER').run();
    }

    await D.prepare('INSERT OR IGNORE INTO sync_meta(id,version) VALUES(1,1)').run();
    await D.prepare('CREATE INDEX IF NOT EXISTS idx_filas_producto_vence_en ON filas(producto_vence_en)').run();

    for (const p of ['Vacío','Soja','Maíz','Girasol','Trigo','Camelina']) {
      await D.prepare('INSERT OR IGNORE INTO productos(nombre) VALUES(?)').bind(p).run();
    }

    for (let f = 1; f <= 14; f++) {
      const sector = f <= 12 ? 'pre' : 'demorado';
      await D.prepare('INSERT OR IGNORE INTO filas(fila,sector) VALUES(?,?)').bind(f,sector).run();
      if (f >= 13) await D.prepare("UPDATE filas SET sector='demorado' WHERE fila=? AND sector<>'demorado'").bind(f).run();
      for (let p = 1; p <= 12; p++) {
        await D.prepare('INSERT OR IGNORE INTO lugares(fila,posicion) VALUES(?,?)').bind(f,p).run();
      }
    }

    for (let f = 16; f <= 32; f++) {
      await D.prepare("INSERT OR IGNORE INTO filas(fila,sector) VALUES(?,'post')").bind(f).run();
      for (let p = 1; p <= 5; p++) {
        await D.prepare('INSERT OR IGNORE INTO lugares(fila,posicion) VALUES(?,?)').bind(f,p).run();
      }
    }
  })();

  return boot;
}

async function bump(D) {
  await D.prepare('UPDATE sync_meta SET version=version+1 WHERE id=1').run();
}

async function currentVersion(D) {
  const v = await D.prepare('SELECT version FROM sync_meta WHERE id=1').first();
  return Number(v?.version || 1);
}

async function expireStale(D) {
  const r = await D.prepare("UPDATE filas SET producto='Vacío', producto_vence_en=NULL, activada_en=NULL WHERE producto_vence_en IS NOT NULL AND producto_vence_en<=unixepoch() AND sector='post' AND producto<>'Vacío' AND NOT EXISTS (SELECT 1 FROM lugares WHERE lugares.fila=filas.fila AND lugares.ocupado=1)").run();
  if (r.meta.changes) await bump(D);
}

async function state(D) {
  await expireStale(D);
  const version = await currentVersion(D);
  const [p, f, l] = await Promise.all([
    D.prepare("SELECT nombre FROM productos ORDER BY CASE WHEN nombre='Vacío' THEN 0 ELSE 1 END, nombre COLLATE NOCASE").all(),
    D.prepare('SELECT fila,sector,producto,sentido,activada_en FROM filas ORDER BY fila').all(),
    D.prepare('SELECT fila,posicion,ocupado,bloqueado,operador FROM lugares ORDER BY fila,posicion').all()
  ]);

  const F = {};
  const L = {};
  for (const r of f.results) F[r.fila] = r;
  for (const r of l.results) {
    (L[r.fila] ??= {})[r.posicion] = {
      ocupado: !!r.ocupado,
      bloqueado: !!r.bloqueado,
      operador: r.operador || ''
    };
  }

  return {
    productos: p.results.map(x => x.nombre),
    filas: F,
    lugares: L,
    version
  };
}

const H = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#1677e8">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<title>Playa Camiones</title>
<style>
*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;padding:8px;background:#eef2f6;color:#172033}.app{max-width:760px;margin:auto}.top,.tools{display:flex;gap:6px;align-items:center}.top{justify-content:space-between;padding:5px 2px}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0}.tab,.b{height:40px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font-weight:800}.tab.on,.b{background:#172033;color:#fff}.tools input{height:40px;min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:0 10px;font-size:16px}.status{font-size:11px;color:#64748b;margin:5px 2px}.guide{font-size:14px;font-weight:800;background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;margin:6px 0;box-shadow:0 1px 3px #0001}.box{overflow-x:auto;background:#fff;border:1px solid #d7dee8;border-radius:12px;box-shadow:0 2px 8px #0001}.row{display:grid;gap:3px;align-items:center;padding:5px;border-bottom:1px solid #e5e7eb}.pre{grid-template-columns:26px 88px 30px repeat(12,32px) 58px;min-width:640px;transition:background .2s}.pre.empty{background:#bbf7d0}.pre.loading{background:#fde68a}.pre.full{background:#fca5a5}.pre.delayed{border-left:5px solid #7c3aed}.preSection{min-width:640px;padding:8px 10px;background:#ede9fe;color:#4c1d95;font-size:11px;font-weight:900;letter-spacing:.4px;border-top:2px solid #c4b5fd;border-bottom:1px solid #ddd6fe}.post{grid-template-columns:26px 88px 30px repeat(5,38px) 58px;min-width:465px;transition:background .2s}.post.empty{background:#bbf7d0}.post.loading{background:#fde68a}.post.full{background:#fca5a5}.num{text-align:center;font-size:12px;font-weight:900}.sel,.dir,.slot,.act{height:34px;border:1px solid #b8c2d0;border-radius:7px;background:#fff}.sel{width:100%;font-size:12px;font-weight:700}.dir{font-size:18px}.slot{font-size:15px;font-weight:900}.slot.on{background:#172033;color:#fff;border-color:#172033}.slot.mine{background:#1677e8;color:#fff;border-color:#1677e8;font-size:10px}.slot.other{background:#f59e0b;color:#172033;border-color:#d97706;font-size:10px}.slot.blocked{background:#e5e7eb;color:#555;border-style:dashed}.actions{display:grid;grid-template-rows:1fr 1fr;gap:3px}.act{height:24px;font-size:9px;font-weight:800;padding:0 2px}.act.cut{background:#fff3cd}.act.open{background:#dcfce7}.hide{display:none}.cnt{font-size:13px;font-weight:800}.head{font-size:9px;color:#64748b;font-weight:800;text-align:center;background:#f8fafc}.toast{position:sticky;bottom:8px;margin:8px auto 0;background:#172033;color:#fff;padding:9px 12px;border-radius:9px;font-size:12px;font-weight:800;width:max-content;opacity:0}.toast.on{opacity:1}.notice{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;padding:20px;z-index:9999}.notice.hide{display:none}.noticeBox{width:min(92vw,430px);background:#fff;border-radius:16px;padding:22px;text-align:center;box-shadow:0 18px 60px #0006}.noticeTitle{font-size:22px;font-weight:900;margin-bottom:10px}.noticeMsg{font-size:17px;font-weight:700;line-height:1.35;white-space:pre-line}.noticeActions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.noticeBtn{height:48px;border:0;border-radius:11px;font-size:16px;font-weight:900}.noticeCancel{background:#e5e7eb;color:#172033}.noticeOk{background:#172033;color:#fff}.noticeActions.single{grid-template-columns:1fr}.noticeActions.single .noticeCancel{display:none}.opgate{position:fixed;inset:0;background:#0f172acc;display:flex;align-items:center;justify-content:center;padding:20px;z-index:10001}.opgate.hide{display:none}.opcard{width:min(92vw,420px);background:#fff;border-radius:16px;padding:24px;text-align:center;box-shadow:0 18px 60px #0006}.opcard h2{margin:0 0 8px;font-size:22px}.opcard p{margin:0 0 15px;color:#475569;font-weight:700}.opcard input{width:100%;height:48px;border:1px solid #94a3b8;border-radius:10px;padding:0 12px;font-size:18px}.opcard button{width:100%;height:48px;margin-top:12px;border:0;border-radius:10px;background:#172033;color:#fff;font-size:16px;font-weight:900}dialog{border:0;border-radius:12px}dialog input{height:40px;font-size:16px}
</style>
</head>
<body>
<div class="app">
<div class="top"><div><b>Playa Camiones</b><div id="sub" style="font-size:10px;color:#666">Pre calado · Filas 1–12 · Demorados 13–14</div></div><div id="cnt" class="cnt hide"><span id="used">0</span>/85</div></div>
<div class="tabs"><button id="tp" class="tab on">Pre calado</button><button id="to" class="tab">Pos calado</button></div>
<div id="st" class="status">Conectando…</div>
<button id="install" class="b hide">📲 Instalar app</button>
<div id="guide" class="guide hide">Próximo lugar: calculando…</div>
<div class="tools"><input id="op" placeholder="Operador"><button id="add" class="b">+ Producto</button><button id="ref" class="b">↻</button></div>
<section id="pre"><div class="box"><div class="row pre head"><div>F</div><div>Producto</div><div>↔</div><div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div><div>7</div><div>8</div><div>9</div><div>10</div><div>11</div><div>12</div><div>Acción</div></div><div id="pr"></div></div></section>
<section id="post" class="hide"><div class="box"><div class="row post head"><div>F</div><div>Producto</div><div>↔</div><div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>Acción</div></div><div id="po"></div></div></section>
<div id="t" class="toast"></div>
<div id="opgate" class="opgate hide" role="dialog" aria-modal="true"><div class="opcard"><h2>IDENTIFICACIÓN OBLIGATORIA</h2><p>Ingresá tu nombre para comenzar.</p><input id="opname" maxlength="40" autocomplete="name" placeholder="Nombre del operador"><button id="opsave">Ingresar</button></div></div>
<div id="notice" class="notice hide" role="alertdialog" aria-modal="true"><div class="noticeBox"><div id="noticeTitle" class="noticeTitle">ATENCIÓN</div><div id="noticeMsg" class="noticeMsg"></div><div id="noticeActions" class="noticeActions single"><button id="noticeCancel" class="noticeBtn noticeCancel">Cancelar</button><button id="noticeOk" class="noticeBtn noticeOk">Aceptar</button></div></div></div>
<dialog id="dlg"><form id="form"><b>Agregar producto</b><br><input id="np" required maxlength="30" placeholder="Ej.: Sorgo"><button>Guardar</button><button type="button" id="can">Cancelar</button></form></dialog>
</div>
<script>
const $=x=>document.getElementById(x),S={productos:[],filas:{},lugares:{}};let tab='pre',busy=false,tm,pauseUntil=0,noticeResolve=null,lastVersion=0;
const savedOp=(localStorage.op||'').trim();$('op').value=savedOp;const who=()=>($('op').value||'').trim();function showOpGate(){const actual=who();$('opname').value=actual;$('opgate').classList.remove('hide');setTimeout(()=>$('opname').focus(),50)}function saveOperator(){const n=($('opname').value||'').trim().slice(0,40);if(!n){$('opname').focus();return}$('op').value=n;localStorage.op=n;$('opgate').classList.add('hide');if(Object.keys(S.filas).length)render()}$('opsave').onclick=saveOperator;$('opname').onkeydown=e=>{if(e.key==='Enter')saveOperator()};$('op').oninput=()=>{localStorage.op=who()};$('op').onfocus=()=>pauseUntil=Date.now()+30000;$('op').onblur=()=>{pauseUntil=0;if(!who())showOpGate();else{localStorage.op=who();if(Object.keys(S.filas).length)render()}setTimeout(()=>load(),300)};if(!savedOp)setTimeout(showOpGate,0);
function initials(n){const a=String(n||'').trim().split(' ').filter(Boolean);if(!a.length)return '●';return (a[0][0]+(a.length>1?a[a.length-1][0]:(a[0][1]||''))).toUpperCase()}
function toast(m){clearTimeout(tm);$('t').textContent=m;$('t').classList.add('on');tm=setTimeout(()=>$('t').classList.remove('on'),1600)}
function closeNotice(value=false){$('notice').classList.add('hide');const r=noticeResolve;noticeResolve=null;if(r)r(value)}
function notice(m,title){$('noticeTitle').textContent=title||((m.includes('ya fue ocupado'))?'LUGAR YA OCUPADO':(m.includes('Próximo lugar')?'ORDEN INCORRECTO':'ATENCIÓN'));$('noticeMsg').textContent=m;$('noticeActions').classList.add('single');$('noticeOk').textContent='Aceptar';$('notice').classList.remove('hide');noticeResolve=null}
function askNotice(m,title='CONFIRMAR',okText='Confirmar'){return new Promise(resolve=>{$('noticeTitle').textContent=title;$('noticeMsg').textContent=m;$('noticeActions').classList.remove('single');$('noticeOk').textContent=okText;$('notice').classList.remove('hide');noticeResolve=resolve})}
$('noticeOk').onclick=()=>closeNotice(true);$('noticeCancel').onclick=()=>closeNotice(false);$('notice').onclick=e=>{if(e.target===$('notice'))closeNotice(false)};
async function api(u,o={}){if(String(o.method||'GET').toUpperCase()==='POST'&&!who()){showOpGate();throw Error('Ingresá tu nombre de operador para continuar')}const r=await fetch(u,{headers:{'content-type':'application/json'},...o}),j=await r.json();if(!r.ok)throw Error(j.error||'Error');return j}
function tabs(x){tab=x;const p=x==='pre';$('pre').classList.toggle('hide',!p);$('post').classList.toggle('hide',p);$('tp').classList.toggle('on',p);$('to').classList.toggle('on',!p);$('cnt').classList.toggle('hide',p);$('guide').classList.toggle('hide',p);$('sub').textContent=p?'Pre calado · Filas 1–12 · Demorados 13–14':'Pos calado · Filas 16–32'}
$('tp').onclick=()=>tabs('pre');$('to').onclick=()=>tabs('post');
function opts(v){return S.productos.map(x=>'<option '+(x===v?'selected':'')+'>'+x+'</option>').join('')}
function sel(f){const s=document.createElement('select');s.className='sel';s.innerHTML=opts(S.filas[f]?.producto||'Vacío');const pausa=()=>{pauseUntil=Date.now()+30000};s.onpointerdown=pausa;s.ontouchstart=pausa;s.onfocus=pausa;s.onchange=async()=>{try{await api('/api/fila',{method:'POST',body:JSON.stringify({fila:f,producto:s.value,operador:who()})});pauseUntil=0;setTimeout(()=>load(),400)}catch(e){pauseUntil=0;toast(e.message)}};s.onblur=()=>{pauseUntil=0;setTimeout(()=>load(),400)};return s}
function dir(f){const b=document.createElement('button');b.className='dir';b.textContent=S.filas[f]?.sentido==='izquierda'?'←':'→';b.onclick=async()=>{try{await api('/api/fila',{method:'POST',body:JSON.stringify({fila:f,sentido:S.filas[f]?.sentido==='izquierda'?'derecha':'izquierda',operador:who()})});load()}catch(e){toast(e.message)}};return b}
function nextPlaces(){const filas=[],resultados=[];for(let f=16;f<=32;f++)if(S.filas[f]?.producto&&S.filas[f].producto!=='Vacío')filas.push(f);filas.sort((a,b)=>(S.filas[b]?.activada_en||0)-(S.filas[a]?.activada_en||0)||a-b);for(const f of filas){const sentido=S.filas[f]?.sentido==='izquierda'?'izquierda':'derecha';const posiciones=sentido==='izquierda'?[5,4,3,2,1]:[1,2,3,4,5];let libres=0,proximo=null;for(const p of posiciones){const x=S.lugares[f]?.[p]||{};if(!x.ocupado&&!x.bloqueado){libres++;if(proximo===null)proximo=p}}if(proximo!==null)resultados.push({fila:f,pos:proximo,libres,producto:S.filas[f].producto})}return resultados}
function updateGuide(){const lugares=nextPlaces(),habilitada=Object.values(S.filas).some(x=>x.sector==='post'&&x.producto&&x.producto!=='Vacío');$('guide').textContent=lugares.length?(lugares.length===1?'Próximo: ':'Próximos: ')+lugares.map(n=>n.producto+' · Fila '+n.fila+' · Posición '+n.pos+' · '+n.libres+' '+(n.libres===1?'libre':'libres')).join('  •  '):(habilitada?'Sin lugares disponibles':'Sin fila habilitada')}
function render(){$('pr').innerHTML='';for(let f=1;f<=14;f++){if(f===13){const sep=document.createElement('div');sep.className='preSection';sep.textContent='DEMORADOS · FILAS 13 Y 14';$('pr').append(sep)}const r=document.createElement('div'),n=document.createElement('div');n.className='num';n.textContent=f;r.append(n,sel(f),dir(f));let ocupados=0;for(let p=1;p<=12;p++){const x=S.lugares[f]?.[p]||{},on=!!x.ocupado,opx=String(x.operador||''),mine=on&&opx&&opx.toLocaleLowerCase()===who().toLocaleLowerCase();if(on)ocupados++;const b=document.createElement('button');b.className='slot'+(on?' on':'')+(mine?' mine':on&&opx?' other':'');b.textContent=on?(mine?'YO':initials(opx)):'·';b.title=on?(opx?'Cargado por: '+opx:'Ocupado'):'Libre';b.onclick=()=>slot(f,p,on,false,opx);r.append(b)}const estado=ocupados===12?'full':(ocupados===0?'empty':'loading');r.className='row pre '+estado+(f>=13?' delayed':'');const a=document.createElement('div');a.className='actions';const l=document.createElement('button');l.className='act open';l.textContent='Llenar';l.disabled=ocupados===12;l.onclick=()=>fillRow(f);const v=document.createElement('button');v.className='act';v.textContent='Vaciar';v.disabled=ocupados===0;v.onclick=()=>clearRow(f);a.append(l,v);r.append(a);$('pr').append(r)}$('po').innerHTML='';let u=0;for(let f=16;f<=32;f++){const r=document.createElement('div'),n=document.createElement('div');n.className='num';n.textContent=f;r.append(n,sel(f),dir(f));let bloqueados=0,ocupados=0;for(let p=1;p<=5;p++){const x=S.lugares[f]?.[p]||{},on=!!x.ocupado,bl=!!x.bloqueado,opx=String(x.operador||''),mine=on&&opx&&opx.toLocaleLowerCase()===who().toLocaleLowerCase();if(on){u++;ocupados++}if(bl)bloqueados++;const b=document.createElement('button');b.className='slot'+(on?' on':'')+(mine?' mine':on&&opx?' other':'')+(bl?' blocked':'');b.textContent=on?(mine?'YO':initials(opx)):bl?'×':'·';b.title=on?(opx?'Cargado por: '+opx:'Ocupado'):(bl?'Bloqueado':'Libre');b.disabled=bl&&!on;b.onclick=()=>slot(f,p,on,bl,opx);r.append(b)}const estado=ocupados===5?'full':(ocupados===0&&S.filas[f]?.producto==='Vacío'?'empty':'loading');r.className='row post '+estado;const a=document.createElement('div');a.className='actions';const c=document.createElement('button');c.className='act '+(bloqueados?'open':'cut');c.textContent=bloqueados?'Reabrir':'Cortar';c.onclick=()=>corte(f,!!bloqueados);const v=document.createElement('button');v.className='act';v.textContent='Vaciar';v.onclick=()=>clearRow(f);a.append(c,v);r.append(a);$('po').append(r)}$('used').textContent=u;updateGuide();tabs(tab)}
async function slot(f,p,on,bl,opx=''){if(bl&&!on)return;if(!who())return showOpGate();if(!on&&(!S.filas[f]?.producto||S.filas[f].producto==='Vacío'))return notice('Primero seleccioná un producto');if(on){const cargado=opx||'Sin identificar';const ok=await askNotice('Fila '+f+' · Lugar '+p+' está ocupado. Cargado por: '+cargado+'. ¿Querés liberarlo?','¿LIBERAR LUGAR?','Liberar');if(!ok)return}try{const j=await api('/api/lugar',{method:'POST',body:JSON.stringify({fila:f,posicion:p,ocupar:!on,operador:who()})});toast(j.message);load()}catch(e){notice(e.message);load()}}
async function corte(f,reabrir){try{const j=await api('/api/corte',{method:'POST',body:JSON.stringify({fila:f,reabrir,operador:who()})});toast(reabrir?j.message:'CORTE — CAMBIAR DE FILA');if(!reabrir)notice('Fila '+f+' cortada. Continuar en la siguiente fila disponible.','CORTE — CAMBIAR DE FILA');load()}catch(e){notice(e.message)}}
async function fillRow(f){if(!who())return showOpGate();if(!S.filas[f]?.producto||S.filas[f].producto==='Vacío')return notice('Primero seleccioná un producto');let c=0;for(let p=1;p<=12;p++)if(S.lugares[f]?.[p]?.ocupado)c++;if(c===12)return toast('Fila '+f+' ya está llena');const ok=await askNotice('Se marcarán ocupados los 12 lugares de la fila '+f+'.','¿LLENAR FILA?','Llenar');if(!ok)return;try{const j=await api('/api/llenar',{method:'POST',body:JSON.stringify({fila:f,operador:who()})});toast(j.message);load()}catch(e){notice(e.message)}}
async function clearRow(f){if(!who())return showOpGate();const max=f<=14?12:5;let c=0;for(let p=1;p<=max;p++)if(S.lugares[f]?.[p]?.ocupado)c++;if(c){const ok=await askNotice('Se liberarán '+c+' '+(c===1?'camión':'camiones')+' de la fila '+f+'.','¿VACIAR FILA?','Vaciar');if(!ok)return}try{const j=await api('/api/vaciar',{method:'POST',body:JSON.stringify({fila:f,operador:who()})});toast(j.message);load()}catch(e){notice(e.message)}}
async function load(force=false){if(busy||(!force&&Date.now()<pauseUntil))return;busy=true;try{const d=await api('/api/state');Object.assign(S,d);lastVersion=Number(d.version||lastVersion||0);render();$('st').textContent='Sincronizado · verifica cambios cada 10 s'}catch(e){$('st').textContent=e.message}finally{busy=false}}
async function checkChanges(){if(busy||Date.now()<pauseUntil||document.hidden)return;try{const v=await api('/api/version');const n=Number(v.version||0);if(n!==lastVersion)await load(true);else $('st').textContent='Sincronizado · sin cambios'}catch(e){$('st').textContent=e.message}}
$('ref').onclick=()=>{pauseUntil=0;load(true)};$('add').onclick=()=>$('dlg').showModal();$('can').onclick=()=>$('dlg').close();$('form').onsubmit=async e=>{e.preventDefault();try{await api('/api/producto',{method:'POST',body:JSON.stringify({nombre:$('np').value.trim(),operador:who()})});$('dlg').close();$('np').value='';load(true)}catch(x){notice(x.message)}};load(true);setInterval(checkChanges,10000);
let installEvent;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;$('install').classList.remove('hide')});$('install').onclick=async()=>{if(!installEvent)return;installEvent.prompt();await installEvent.userChoice;installEvent=null;$('install').classList.add('hide')};window.addEventListener('appinstalled',()=>$('install').classList.add('hide'));if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js'));
</script>
</body>
</html>`;

export default {
  async fetch(req, env) {
    try {
      const u = new URL(req.url);
      if (u.pathname === '/' && req.method === 'GET') {
        return new Response(H, {headers:{'content-type':'text/html;charset=UTF-8','cache-control':'no-store'}});
      }
      if (u.pathname === '/icon.svg' && req.method === 'GET') return new Response(ICON,{headers:{'content-type':'image/svg+xml','cache-control':'public,max-age=86400'}});
      if (u.pathname === '/manifest.webmanifest' && req.method === 'GET') return new Response(JSON.stringify({name:'Playa Camiones',short_name:'Playa',description:'Gestión de filas y lugares de camiones',start_url:'/',scope:'/',display:'standalone',background_color:'#eef2f6',theme_color:'#1677e8',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]}),{headers:{'content-type':'application/manifest+json','cache-control':'no-cache'}});
      if (u.pathname === '/sw.js' && req.method === 'GET') return new Response(SW,{headers:{'content-type':'text/javascript;charset=UTF-8','cache-control':'no-store'}});

      await init(env);
      const D = db(env);
      const b = req.method === 'POST' ? await req.json().catch(()=>({})) : {};
      const operador = String(b.operador||'').trim().slice(0,40);
      if (req.method === 'POST' && ['/api/fila','/api/producto','/api/lugar','/api/llenar','/api/corte','/api/vaciar'].includes(u.pathname) && !operador) return J({error:'Ingresá tu nombre de operador para continuar'},400);

      if (u.pathname === '/api/version' && req.method === 'GET') {
        await expireStale(D);
        return J({version:await currentVersion(D)});
      }

      if (u.pathname === '/api/state' && req.method === 'GET') return J(await state(D));

      if (u.pathname === '/api/fila' && req.method === 'POST') {
        const f = +b.fila;
        let changed=false;
        if (b.producto !== undefined) {
          const producto=String(b.producto);
          await D.prepare("UPDATE filas SET producto=?, producto_vence_en=CASE WHEN sector='post' AND ?<>'Vacío' AND NOT EXISTS (SELECT 1 FROM lugares WHERE lugares.fila=filas.fila AND lugares.ocupado=1) THEN unixepoch()+600 ELSE NULL END, activada_en=CASE WHEN sector='post' AND ?<>'Vacío' THEN unixepoch() ELSE NULL END WHERE fila=?").bind(producto,producto,producto,f).run();
          changed=true;
        }
        if (b.sentido !== undefined) {
          await D.prepare('UPDATE filas SET sentido=? WHERE fila=?').bind(String(b.sentido),f).run();
          changed=true;
        }
        if(changed)await bump(D);
        return J({ok:true});
      }

      if (u.pathname === '/api/producto' && req.method === 'POST') {
        const n = String(b.nombre||'').trim().slice(0,30);
        if (!n) return J({error:'Escribí un producto'},400);
        try {
          await D.prepare('INSERT INTO productos(nombre) VALUES(?)').bind(n).run();
          await bump(D);
          return J({ok:true});
        } catch {
          return J({error:'Ese producto ya existe'},409);
        }
      }

      if (u.pathname === '/api/lugar' && req.method === 'POST') {
        const f=+b.fila,p=+b.posicion,o=operador,q=b.ocupar?1:0,old=q?0:1;
        const filaActual = await D.prepare('SELECT producto,sentido FROM filas WHERE fila=?').bind(f).first();
        if (q && (!filaActual?.producto || filaActual.producto === 'Vacío')) return J({error:'Primero seleccioná un producto'},409);
        const lugarActual = await D.prepare('SELECT ocupado,bloqueado FROM lugares WHERE fila=? AND posicion=?').bind(f,p).first();
        if (q && lugarActual?.ocupado) return J({error:'Ese lugar ya fue ocupado por otro operador. La pantalla fue actualizada.'},409);
        if (q && lugarActual?.bloqueado) return J({error:'Ese lugar está bloqueado por cruce'},409);
        if (q) {
          const orden = filaActual?.sentido === 'izquierda' ? 'DESC' : 'ASC';
          const siguiente = await D.prepare('SELECT posicion FROM lugares WHERE fila=? AND ocupado=0 AND bloqueado=0 ORDER BY posicion '+orden+' LIMIT 1').bind(f).first();
          if (!siguiente) return J({error:'No hay lugares disponibles en esta fila'},409);
          if (+siguiente.posicion !== p) return J({error:'Ese lugar no corresponde todavía. Próximo lugar: Fila '+f+' · Lugar '+siguiente.posicion},409);
        }
        const r=await D.prepare('UPDATE lugares SET ocupado=?,operador=CASE WHEN ?=1 THEN ? ELSE NULL END WHERE fila=? AND posicion=? AND ocupado=?').bind(q,q,o,f,p,old).run();
        if(!r.meta.changes)return J({error:q?'Ese lugar ya fue ocupado por otro operador. La pantalla fue actualizada.':'Ese lugar ya estaba libre'},409);
        if(q)await D.prepare('UPDATE filas SET producto_vence_en=NULL WHERE fila=?').bind(f).run();
        await D.prepare('INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,?,?,?)').bind(f,p,q?'OCUPAR':'LIBERAR',o).run();
        if (!q) {
          const max=f<=14?12:5;
          const orden = filaActual?.sentido === 'izquierda' ? 'DESC' : 'ASC';
          const restantes = await D.prepare('SELECT operador FROM lugares WHERE fila=? AND ocupado=1 AND posicion BETWEEN 1 AND ? ORDER BY posicion '+orden).bind(f,max).all();
          const destinos = await D.prepare('SELECT posicion FROM lugares WHERE fila=? AND bloqueado=0 AND posicion BETWEEN 1 AND ? ORDER BY posicion '+orden).bind(f,max).all();
          const cambios = destinos.results.map((d,i)=>D.prepare('UPDATE lugares SET ocupado=?,operador=? WHERE fila=? AND posicion=?').bind(i<restantes.results.length?1:0,i<restantes.results.length?(restantes.results[i].operador||''):null,f,d.posicion));
          if(cambios.length)await D.batch(cambios);
        }
        await bump(D);
        return J({ok:true,message:q?'Fila '+f+' · lugar '+p+' ocupado':'Fila '+f+' · lugar liberado · posiciones reacomodadas'});
      }

      if (u.pathname === '/api/llenar' && req.method === 'POST') {
        const f=+b.fila,o=operador;
        if (f<1 || f>14) return J({error:'Fila inválida'},400);
        const filaActual=await D.prepare("SELECT producto FROM filas WHERE fila=? AND sector IN ('pre','demorado')").bind(f).first();
        if (!filaActual) return J({error:'Fila inválida'},400);
        if (!filaActual.producto || filaActual.producto==='Vacío') return J({error:'Primero seleccioná un producto'},409);
        await D.prepare('UPDATE lugares SET ocupado=1,bloqueado=0,operador=? WHERE fila=? AND posicion BETWEEN 1 AND 12').bind(o,f).run();
        await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'LLENAR_FILA_12',?)").bind(f,o).run();
        await bump(D);
        return J({ok:true,message:'Fila '+f+' llena · 12/12 camiones'});
      }

      if (u.pathname === '/api/corte' && req.method === 'POST') {
        const f=+b.fila,o=operador,reabrir=!!b.reabrir;
        if (f<16 || f>32) return J({error:'Fila inválida'},400);
        if (reabrir) {
          await D.prepare('UPDATE lugares SET bloqueado=0 WHERE fila=?').bind(f).run();
          await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'REABRIR_FILA',?)").bind(f,o).run();
          await bump(D);
          return J({ok:true,message:'Fila '+f+' reabierta'});
        }
        const libres = await D.prepare('SELECT COUNT(*) c FROM lugares WHERE fila=? AND ocupado=0 AND bloqueado=0').bind(f).first();
        if (!libres?.c) return J({error:'No hay lugares libres para bloquear'},409);
        await D.prepare('UPDATE lugares SET bloqueado=1 WHERE fila=? AND ocupado=0').bind(f).run();
        await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'CORTE_FILA',?)").bind(f,o).run();
        await bump(D);
        return J({ok:true,message:'Fila '+f+' cortada · continuar en la siguiente disponible'});
      }

      if (u.pathname === '/api/vaciar' && req.method === 'POST') {
        const f=+b.fila,o=operador;
        const c=await D.prepare('SELECT COUNT(*) c FROM lugares WHERE fila=? AND ocupado=1').bind(f).first();
        await D.prepare('UPDATE lugares SET ocupado=0,operador=NULL WHERE fila=?').bind(f).run();
        await D.prepare("UPDATE filas SET producto='Vacío',producto_vence_en=NULL,activada_en=NULL WHERE fila=?").bind(f).run();
        await bump(D);
        if(!c?.c)return J({ok:true,message:'Fila '+f+' marcada como vacía'});
        await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'VACIAR_FILA',?)").bind(f,o).run();
        return J({ok:true,message:'Fila '+f+' vaciada'});
      }

      return J({error:'No encontrado'},404);
    } catch(e) {
      return J({error:e.message||'Error interno'},500);
    }
  }
};
