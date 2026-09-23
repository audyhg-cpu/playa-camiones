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
      D.prepare("CREATE TABLE IF NOT EXISTS movimientos(id INTEGER PRIMARY KEY AUTOINCREMENT,fila INTEGER NOT NULL,posicion INTEGER,accion TEXT NOT NULL,operador TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP)")
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

    for (const p of ['Vacío','Soja','Maíz','Girasol','Trigo','Camelina']) {
      await D.prepare('INSERT OR IGNORE INTO productos(nombre) VALUES(?)').bind(p).run();
    }

    for (let f = 1; f <= 12; f++) {
      await D.prepare("INSERT OR IGNORE INTO filas(fila,sector) VALUES(?,'pre')").bind(f).run();
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

async function state(D) {
  await D.prepare("UPDATE filas SET producto='Vacío', producto_vence_en=NULL, activada_en=NULL WHERE sector='post' AND producto<>'Vacío' AND producto_vence_en IS NOT NULL AND producto_vence_en<=unixepoch() AND NOT EXISTS (SELECT 1 FROM lugares WHERE lugares.fila=filas.fila AND lugares.ocupado=1)").run();
  const [p, f, l] = await Promise.all([
    D.prepare("SELECT nombre FROM productos ORDER BY CASE WHEN nombre='Vacío' THEN 0 ELSE 1 END, nombre COLLATE NOCASE").all(),
    D.prepare('SELECT fila,sector,producto,sentido,activada_en FROM filas ORDER BY fila').all(),
    D.prepare('SELECT fila,posicion,ocupado,bloqueado FROM lugares ORDER BY fila,posicion').all()
  ]);

  const F = {};
  const L = {};
  for (const r of f.results) F[r.fila] = r;
  for (const r of l.results) {
    (L[r.fila] ??= {})[r.posicion] = {
      ocupado: !!r.ocupado,
      bloqueado: !!r.bloqueado
    };
  }

  return {
    productos: p.results.map(x => x.nombre),
    filas: F,
    lugares: L
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
*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;padding:8px;background:#eef2f6;color:#172033}.app{max-width:760px;margin:auto}.top,.tools{display:flex;gap:6px;align-items:center}.top{justify-content:space-between;padding:5px 2px}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0}.tab,.b{height:40px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;font-weight:800}.tab.on,.b{background:#172033;color:#fff}.tools input{height:40px;min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:0 10px;font-size:16px}.status{font-size:11px;color:#64748b;margin:5px 2px}.guide{font-size:14px;font-weight:800;background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;margin:6px 0;box-shadow:0 1px 3px #0001}.box{overflow-x:auto;background:#fff;border:1px solid #d7dee8;border-radius:12px;box-shadow:0 2px 8px #0001}.row{display:grid;gap:3px;align-items:center;padding:5px;border-bottom:1px solid #e5e7eb}.pre{grid-template-columns:30px minmax(130px,1fr) 58px;transition:background .2s}.pre.enabled{background:#bbf7d0}.pre.disabled{background:#fca5a5}.post{grid-template-columns:26px 88px 30px repeat(5,38px) 58px;min-width:465px;transition:background .2s}.post.empty{background:#bbf7d0}.post.loading{background:#fde68a}.post.full{background:#fca5a5}.num{text-align:center;font-size:12px;font-weight:900}.sel,.dir,.slot,.act{height:34px;border:1px solid #b8c2d0;border-radius:7px;background:#fff}.sel{width:100%;font-size:12px;font-weight:700}.dir{font-size:18px}.slot{font-size:15px;font-weight:900}.slot.on{background:#172033;color:#fff;border-color:#172033}.slot.blocked{background:#e5e7eb;color:#555;border-style:dashed}.actions{display:grid;grid-template-rows:1fr 1fr;gap:3px}.act{height:24px;font-size:9px;font-weight:800;padding:0 2px}.act.cut{background:#fff3cd}.act.open{background:#dcfce7}.hide{display:none}.cnt{font-size:13px;font-weight:800}.head{font-size:9px;color:#64748b;font-weight:800;text-align:center;background:#f8fafc}.toast{position:sticky;bottom:8px;margin:8px auto 0;background:#172033;color:#fff;padding:9px 12px;border-radius:9px;font-size:12px;font-weight:800;width:max-content;opacity:0}.toast.on{opacity:1}dialog{border:0;border-radius:12px}dialog input{height:40px;font-size:16px}</style>
</head>
<body>
<div class="app">
<div class="top"><div><b>Playa Camiones</b><div id="sub" style="font-size:10px;color:#666">Pre calado · Filas 1–12</div></div><div id="cnt" class="cnt hide"><span id="used">0</span>/85</div></div>
<div class="tabs"><button id="tp" class="tab on">Pre calado</button><button id="to" class="tab">Pos calado</button></div>
<div id="st" class="status">Conectando…</div>
<button id="install" class="b hide">📲 Instalar app</button>
<div id="guide" class="guide hide">Próximo lugar: calculando…</div>
<div class="tools"><input id="op" placeholder="Operador"><button id="add" class="b">+ Producto</button><button id="ref" class="b">↻</button></div>
<section id="pre"><div class="box"><div class="row pre head"><div>F</div><div>Producto</div><div>Flujo</div></div><div id="pr"></div></div></section>
<section id="post" class="hide"><div class="box"><div class="row post head"><div>F</div><div>Producto</div><div>↔</div><div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>Acción</div></div><div id="po"></div></div></section>
<div id="t" class="toast"></div>
<dialog id="dlg"><form id="form"><b>Agregar producto</b><br><input id="np" required maxlength="30" placeholder="Ej.: Sorgo"><button>Guardar</button><button type="button" id="can">Cancelar</button></form></dialog>
</div>
<script>
const $=x=>document.getElementById(x),S={productos:[],filas:{},lugares:{}};let tab='pre',busy=false,tm,pauseUntil=0;
$('op').value=localStorage.op||'';$('op').oninput=()=>localStorage.op=$('op').value;$('op').onfocus=()=>pauseUntil=Date.now()+30000;$('op').onblur=()=>{pauseUntil=0;setTimeout(()=>load(),300)};const who=()=>$('op').value.trim()||'Sin nombre';
function toast(m){clearTimeout(tm);$('t').textContent=m;$('t').classList.add('on');tm=setTimeout(()=>$('t').classList.remove('on'),1600)}
async function api(u,o={}){const r=await fetch(u,{headers:{'content-type':'application/json'},...o}),j=await r.json();if(!r.ok)throw Error(j.error||'Error');return j}
function tabs(x){tab=x;const p=x==='pre';$('pre').classList.toggle('hide',!p);$('post').classList.toggle('hide',p);$('tp').classList.toggle('on',p);$('to').classList.toggle('on',!p);$('cnt').classList.toggle('hide',p);$('guide').classList.toggle('hide',p);$('sub').textContent=p?'Pre calado · Filas 1–12':'Pos calado · Filas 16–32'}
$('tp').onclick=()=>tabs('pre');$('to').onclick=()=>tabs('post');
function opts(v){return S.productos.map(x=>'<option '+(x===v?'selected':'')+'>'+x+'</option>').join('')}
function sel(f){const s=document.createElement('select');s.className='sel';s.innerHTML=opts(S.filas[f]?.producto||'Vacío');const pausa=()=>{pauseUntil=Date.now()+30000};s.onpointerdown=pausa;s.ontouchstart=pausa;s.onfocus=pausa;s.onchange=async()=>{try{await api('/api/fila',{method:'POST',body:JSON.stringify({fila:f,producto:s.value,operador:who()})});pauseUntil=0;setTimeout(()=>load(),400)}catch(e){pauseUntil=0;toast(e.message)}};s.onblur=()=>{pauseUntil=0;setTimeout(()=>load(),400)};return s}
function dir(f){const b=document.createElement('button');b.className='dir';b.textContent=S.filas[f]?.sentido==='izquierda'?'←':'→';b.onclick=async()=>{try{await api('/api/fila',{method:'POST',body:JSON.stringify({fila:f,sentido:S.filas[f]?.sentido==='izquierda'?'derecha':'izquierda',operador:who()})});load()}catch(e){toast(e.message)}};return b}
function nextPlaces(){const filas=[],resultados=[];for(let f=16;f<=32;f++)if(S.filas[f]?.producto&&S.filas[f].producto!=='Vacío')filas.push(f);filas.sort((a,b)=>(S.filas[b]?.activada_en||0)-(S.filas[a]?.activada_en||0)||a-b);for(const f of filas){let libres=0,proximo=null;for(let p=1;p<=5;p++){const x=S.lugares[f]?.[p]||{};if(!x.ocupado&&!x.bloqueado){libres++;if(proximo===null)proximo=p}}if(proximo!==null)resultados.push({fila:f,pos:proximo,libres,producto:S.filas[f].producto})}return resultados}
function updateGuide(){const lugares=nextPlaces(),habilitada=Object.values(S.filas).some(x=>x.sector==='post'&&x.producto&&x.producto!=='Vacío');$('guide').textContent=lugares.length?(lugares.length===1?'Próximo: ':'Próximos: ')+lugares.map(n=>n.producto+' · Fila '+n.fila+' · Posición '+n.pos+' · '+n.libres+' '+(n.libres===1?'libre':'libres')).join('  •  '):(habilitada?'Sin lugares disponibles':'Sin fila habilitada')}
function render(){$('pr').innerHTML='';for(let f=1;f<=12;f++){const r=document.createElement('div'),n=document.createElement('div'),habilitada=S.filas[f]?.producto!=='Vacío';r.className='row pre '+(habilitada?'enabled':'disabled');n.className='num';n.textContent=f;r.append(n,sel(f),dir(f));$('pr').append(r)}$('po').innerHTML='';let u=0;for(let f=16;f<=32;f++){const r=document.createElement('div'),n=document.createElement('div');n.className='num';n.textContent=f;r.append(n,sel(f),dir(f));let bloqueados=0,ocupados=0;for(let p=1;p<=5;p++){const x=S.lugares[f]?.[p]||{},on=!!x.ocupado,bl=!!x.bloqueado;if(on){u++;ocupados++}if(bl)bloqueados++;const b=document.createElement('button');b.className='slot'+(on?' on':'')+(bl?' blocked':'');b.textContent=on?'●':bl?'×':'·';b.disabled=bl&&!on;b.onclick=()=>slot(f,p,on,bl);r.append(b)}const estado=ocupados===5?'full':(ocupados===0&&S.filas[f]?.producto==='Vacío'?'empty':'loading');r.className='row post '+estado;const a=document.createElement('div');a.className='actions';const c=document.createElement('button');c.className='act '+(bloqueados?'open':'cut');c.textContent=bloqueados?'Reabrir':'Cortar';c.onclick=()=>corte(f,!!bloqueados);const v=document.createElement('button');v.className='act';v.textContent='Vaciar';v.onclick=()=>clearRow(f);a.append(c,v);r.append(a);$('po').append(r)}$('used').textContent=u;updateGuide();tabs(tab)}
async function slot(f,p,on,bl){if(bl&&!on)return;if(!on&&(!S.filas[f]?.producto||S.filas[f].producto==='Vacío'))return toast('Primero seleccioná un producto');try{const j=await api('/api/lugar',{method:'POST',body:JSON.stringify({fila:f,posicion:p,ocupar:!on,operador:who()})});toast(j.message);load()}catch(e){toast(e.message);load()}}
async function corte(f,reabrir){try{const j=await api('/api/corte',{method:'POST',body:JSON.stringify({fila:f,reabrir,operador:who()})});toast(reabrir?j.message:'CORTE — CAMBIAR DE FILA');if(!reabrir)alert('CORTE — CAMBIAR DE FILA');load()}catch(e){toast(e.message)}}
async function clearRow(f){let c=0;for(let p=1;p<=5;p++)if(S.lugares[f]?.[p]?.ocupado)c++;if(c&&!confirm('¿Vaciar fila '+f+'?'))return;try{const j=await api('/api/vaciar',{method:'POST',body:JSON.stringify({fila:f,operador:who()})});toast(j.message);load()}catch(e){toast(e.message)}}
async function load(){if(busy||Date.now()<pauseUntil)return;busy=true;try{const d=await api('/api/state');Object.assign(S,d);render();$('st').textContent='Sincronizado · actualiza cada 2 s'}catch(e){$('st').textContent=e.message}finally{busy=false}}
$('ref').onclick=()=>{pauseUntil=0;load()};$('add').onclick=()=>$('dlg').showModal();$('can').onclick=()=>$('dlg').close();$('form').onsubmit=async e=>{e.preventDefault();try{await api('/api/producto',{method:'POST',body:JSON.stringify({nombre:$('np').value.trim()})});$('dlg').close();$('np').value='';load()}catch(x){toast(x.message)}};load();setInterval(()=>{if(!document.hidden&&Date.now()>=pauseUntil)load()},2000);
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

      if (u.pathname === '/api/state' && req.method === 'GET') return J(await state(D));

      if (u.pathname === '/api/fila' && req.method === 'POST') {
        const f = +b.fila;
        if (b.producto !== undefined) {
          const producto=String(b.producto);
          await D.prepare("UPDATE filas SET producto=?, producto_vence_en=CASE WHEN sector='post' AND ?<>'Vacío' AND NOT EXISTS (SELECT 1 FROM lugares WHERE lugares.fila=filas.fila AND lugares.ocupado=1) THEN unixepoch()+600 ELSE NULL END, activada_en=CASE WHEN sector='post' AND ?<>'Vacío' THEN unixepoch() ELSE NULL END WHERE fila=?").bind(producto,producto,producto,f).run();
        }
        if (b.sentido !== undefined) await D.prepare('UPDATE filas SET sentido=? WHERE fila=?').bind(String(b.sentido),f).run();
        return J({ok:true});
      }

      if (u.pathname === '/api/producto' && req.method === 'POST') {
        const n = String(b.nombre||'').trim().slice(0,30);
        if (!n) return J({error:'Escribí un producto'},400);
        try {
          await D.prepare('INSERT INTO productos(nombre) VALUES(?)').bind(n).run();
          return J({ok:true});
        } catch {
          return J({error:'Ese producto ya existe'},409);
        }
      }

      if (u.pathname === '/api/lugar' && req.method === 'POST') {
        const f=+b.fila,p=+b.posicion,o=String(b.operador||'Sin nombre').slice(0,40),q=b.ocupar?1:0,old=q?0:1;
        const filaActual = await D.prepare('SELECT producto FROM filas WHERE fila=?').bind(f).first();
        if (q && (!filaActual?.producto || filaActual.producto === 'Vacío')) return J({error:'Primero seleccioná un producto'},409);
        const block = await D.prepare('SELECT bloqueado FROM lugares WHERE fila=? AND posicion=?').bind(f,p).first();
        if (q && block?.bloqueado) return J({error:'Ese lugar está bloqueado por cruce'},409);
        const r=await D.prepare('UPDATE lugares SET ocupado=?,operador=? WHERE fila=? AND posicion=? AND ocupado=?').bind(q,o,f,p,old).run();
        if(!r.meta.changes)return J({error:q?'Ese lugar ya fue ocupado':'Ese lugar ya estaba libre'},409);
        if(q)await D.prepare('UPDATE filas SET producto_vence_en=NULL WHERE fila=?').bind(f).run();
        await D.prepare('INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,?,?,?)').bind(f,p,q?'OCUPAR':'LIBERAR',o).run();
        return J({ok:true,message:'Fila '+f+' · lugar '+p+' '+(q?'ocupado':'libre')});
      }

      if (u.pathname === '/api/corte' && req.method === 'POST') {
        const f=+b.fila,o=String(b.operador||'Sin nombre').slice(0,40),reabrir=!!b.reabrir;
        if (f<16 || f>32) return J({error:'Fila inválida'},400);
        if (reabrir) {
          await D.prepare('UPDATE lugares SET bloqueado=0 WHERE fila=?').bind(f).run();
          await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'REABRIR_FILA',?)").bind(f,o).run();
          return J({ok:true,message:'Fila '+f+' reabierta'});
        }
        const libres = await D.prepare('SELECT COUNT(*) c FROM lugares WHERE fila=? AND ocupado=0 AND bloqueado=0').bind(f).first();
        if (!libres?.c) return J({error:'No hay lugares libres para bloquear'},409);
        await D.prepare('UPDATE lugares SET bloqueado=1 WHERE fila=? AND ocupado=0').bind(f).run();
        await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'CORTE_FILA',?)").bind(f,o).run();
        return J({ok:true,message:'Fila '+f+' cortada · continuar en la siguiente disponible'});
      }

      if (u.pathname === '/api/vaciar' && req.method === 'POST') {
        const f=+b.fila,o=String(b.operador||'Sin nombre').slice(0,40);
        const c=await D.prepare('SELECT COUNT(*) c FROM lugares WHERE fila=? AND ocupado=1').bind(f).first();
        await D.prepare('UPDATE lugares SET ocupado=0,operador=? WHERE fila=?').bind(o,f).run();
        await D.prepare("UPDATE filas SET producto='Vacío',producto_vence_en=NULL,activada_en=NULL WHERE fila=?").bind(f).run();
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
