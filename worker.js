let boot;

const db = env => env.DB || env.db;

const J = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=UTF-8',
    'cache-control': 'no-store'
  }
});

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
  const [p, f, l] = await Promise.all([
    D.prepare("SELECT nombre FROM productos ORDER BY CASE WHEN nombre='Vacío' THEN 0 ELSE 1 END, nombre COLLATE NOCASE").all(),
    D.prepare('SELECT fila,sector,producto,sentido FROM filas ORDER BY fila').all(),
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
<title>Playa Camiones</title>
<style>
*{box-sizing:border-box}body{font-family:Arial;margin:0;padding:5px;background:#f3f4f6;color:#111}.app{max-width:760px;margin:auto}.top,.tools{display:flex;gap:4px;align-items:center}.top{justify-content:space-between}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:5px 0}.tab,.b{height:34px;border:1px solid #ccd;border-radius:7px;background:#fff;font-weight:700}.tab.on,.b{background:#111;color:#fff}.tools input{height:34px;min-width:0;flex:1;border:1px solid #ccd;border-radius:7px;padding:0 8px}.status{font-size:11px;color:#666;margin:4px 0}.guide{font-size:13px;font-weight:800;background:#fff;border:1px solid #ddd;border-radius:7px;padding:7px 9px;margin:5px 0}.box{overflow-x:auto;background:#fff;border:1px solid #ddd;border-radius:8px}.row{display:grid;gap:2px;align-items:center;padding:3px;border-bottom:1px solid #eee}.pre{grid-template-columns:28px minmax(125px,1fr) 58px}.post{grid-template-columns:24px 82px 28px repeat(5,36px) 54px;min-width:438px}.num{text-align:center;font-size:11px;font-weight:700}.sel,.dir,.slot,.act{height:29px;border:1px solid #ccd;border-radius:5px;background:#fff}.sel{width:100%;font-size:11px}.dir{font-size:16px}.slot{font-size:13px;font-weight:800}.slot.on{background:#111;color:#fff;border-color:#111}.slot.blocked{background:#e5e7eb;color:#555;border-style:dashed}.actions{display:grid;grid-template-rows:1fr 1fr;gap:2px}.act{height:21px;font-size:8px;font-weight:700;padding:0 2px}.act.cut{background:#fff3cd}.act.open{background:#dcfce7}.hide{display:none}.cnt{font-size:12px;font-weight:700}.head{font-size:9px;color:#666;font-weight:700;text-align:center}.toast{position:sticky;bottom:6px;margin:6px auto 0;background:#111;color:#fff;padding:6px 9px;border-radius:6px;font-size:10px;width:max-content;opacity:0}.toast.on{opacity:1}dialog{border:0;border-radius:8px}dialog input{height:36px;font-size:16px}</style>
</head>
<body>
<div class="app">
<div class="top"><div><b>Playa Camiones</b><div id="sub" style="font-size:10px;color:#666">Pre calado · Filas 1–12</div></div><div id="cnt" class="cnt hide"><span id="used">0</span>/85</div></div>
<div class="tabs"><button id="tp" class="tab on">Pre calado</button><button id="to" class="tab">Pos calado</button></div>
<div id="st" class="status">Conectando…</div>
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
function nextPlace(){for(let f=16;f<=32;f++){const sentido=S.filas[f]?.sentido==='izquierda'?'izquierda':'derecha';const orden=sentido==='izquierda'?[5,4,3,2,1]:[1,2,3,4,5];for(const p of orden){const x=S.lugares[f]?.[p]||{};if(!x.ocupado&&!x.bloqueado)return{fila:f,pos:p,producto:S.filas[f]?.producto||'Vacío'}}}return null}
function updateGuide(){const n=nextPlace();$('guide').textContent=n?'Próximo lugar: Fila '+n.fila+' · Lugar '+n.pos+' · '+n.producto:'Sin lugares disponibles'}
function render(){$('pr').innerHTML='';for(let f=1;f<=12;f++){const r=document.createElement('div'),n=document.createElement('div');r.className='row pre';n.className='num';n.textContent=f;r.append(n,sel(f),dir(f));$('pr').append(r)}$('po').innerHTML='';let u=0;for(let f=16;f<=32;f++){const r=document.createElement('div'),n=document.createElement('div');r.className='row post';n.className='num';n.textContent=f;r.append(n,sel(f),dir(f));let bloqueados=0;for(let p=1;p<=5;p++){const x=S.lugares[f]?.[p]||{},on=!!x.ocupado,bl=!!x.bloqueado;if(on)u++;if(bl)bloqueados++;const b=document.createElement('button');b.className='slot'+(on?' on':'')+(bl?' blocked':'');b.textContent=on?'●':bl?'×':'·';b.disabled=bl&&!on;b.onclick=()=>slot(f,p,on,bl);r.append(b)}const a=document.createElement('div');a.className='actions';const c=document.createElement('button');c.className='act '+(bloqueados?'open':'cut');c.textContent=bloqueados?'Reabrir':'Cortar';c.onclick=()=>corte(f,!!bloqueados);const v=document.createElement('button');v.className='act';v.textContent='Vaciar';v.onclick=()=>clearRow(f);a.append(c,v);r.append(a);$('po').append(r)}$('used').textContent=u;updateGuide();tabs(tab)}
async function slot(f,p,on,bl){if(bl&&!on)return;try{const j=await api('/api/lugar',{method:'POST',body:JSON.stringify({fila:f,posicion:p,ocupar:!on,operador:who()})});toast(j.message);load()}catch(e){toast(e.message);load()}}
async function corte(f,reabrir){try{const j=await api('/api/corte',{method:'POST',body:JSON.stringify({fila:f,reabrir,operador:who()})});toast(j.message);load()}catch(e){toast(e.message)}}
async function clearRow(f){let c=0;for(let p=1;p<=5;p++)if(S.lugares[f]?.[p]?.ocupado)c++;if(!c)return toast('Fila '+f+' ya está vacía');if(!confirm('¿Vaciar fila '+f+'?'))return;try{const j=await api('/api/vaciar',{method:'POST',body:JSON.stringify({fila:f,operador:who()})});toast(j.message);load()}catch(e){toast(e.message)}}
async function load(){if(busy||Date.now()<pauseUntil)return;busy=true;try{const d=await api('/api/state');Object.assign(S,d);render();$('st').textContent='Sincronizado · actualiza cada 2 s'}catch(e){$('st').textContent=e.message}finally{busy=false}}
$('ref').onclick=()=>{pauseUntil=0;load()};$('add').onclick=()=>$('dlg').showModal();$('can').onclick=()=>$('dlg').close();$('form').onsubmit=async e=>{e.preventDefault();try{await api('/api/producto',{method:'POST',body:JSON.stringify({nombre:$('np').value.trim()})});$('dlg').close();$('np').value='';load()}catch(x){toast(x.message)}};load();setInterval(()=>{if(!document.hidden&&Date.now()>=pauseUntil)load()},2000);
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

      await init(env);
      const D = db(env);
      const b = req.method === 'POST' ? await req.json().catch(()=>({})) : {};

      if (u.pathname === '/api/state' && req.method === 'GET') return J(await state(D));

      if (u.pathname === '/api/fila' && req.method === 'POST') {
        const f = +b.fila;
        if (b.producto !== undefined) await D.prepare('UPDATE filas SET producto=? WHERE fila=?').bind(String(b.producto),f).run();
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
        const block = await D.prepare('SELECT bloqueado FROM lugares WHERE fila=? AND posicion=?').bind(f,p).first();
        if (q && block?.bloqueado) return J({error:'Ese lugar está bloqueado por cruce'},409);
        const r=await D.prepare('UPDATE lugares SET ocupado=?,operador=? WHERE fila=? AND posicion=? AND ocupado=?').bind(q,o,f,p,old).run();
        if(!r.meta.changes)return J({error:q?'Ese lugar ya fue ocupado':'Ese lugar ya estaba libre'},409);
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
        if(!c?.c)return J({ok:true,message:'Fila '+f+' ya está vacía'});
        await D.prepare('UPDATE lugares SET ocupado=0,operador=? WHERE fila=?').bind(o,f).run();
        await D.prepare("INSERT INTO movimientos(fila,posicion,accion,operador) VALUES(?,NULL,'VACIAR_FILA',?)").bind(f,o).run();
        return J({ok:true,message:'Fila '+f+' vaciada'});
      }

      return J({error:'No encontrado'},404);
    } catch(e) {
      return J({error:e.message||'Error interno'},500);
    }
  }
};
