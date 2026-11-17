// Abre el Chrome propio del autoconfirmador para iniciar sesión en Tiendanube UNA vez.
// Mientras está abierto:
//  - guarda la sesión en ./estado/sesion.json (para que el programa la reuse, aunque se cierre Chrome)
//  - anota qué llamadas internas hace el panel (./estado/llamadas.jsonl), sin claves, para mapear la API.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'estado');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const SESION = path.join(DIR, 'sesion.json');
const LLAMADAS = path.join(DIR, 'llamadas.jsonl');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, 'perfil'), {
    channel: 'chrome', headless: false, viewport: null, args: ['--start-maximized'],
  });
  if (fs.existsSync(SESION)) {
    try { await ctx.addCookies(JSON.parse(fs.readFileSync(SESION, 'utf8')).cookies || []); } catch (_) {}
  }

  ctx.on('response', async resp => {
    const req = resp.request();
    const u = req.url();
    if (!/cirrus\.tiendanube\.com|api\.tiendanube\.com/.test(u)) return;
    const h = req.headers();
    let cuerpo = '';
    try { if (/json/.test(resp.headers()['content-type'] || '')) cuerpo = (await resp.text()).slice(0, 4000); } catch (_) {}
    const reg = {
      t: new Date().toISOString(), metodo: req.method(), url: u.split('?')[0],
      params: [...new URL(u).searchParams.entries()].filter(([, v]) => v).map(([k, v]) => k + '=' + v.slice(0, 40)).join('&'),
      headers: Object.keys(h).filter(k => !/cookie/i.test(k)).map(k => /auth|token|csrf|session/i.test(k) ? k + '=<' + h[k].length + '>' : k + '=' + h[k].slice(0, 60)),
      body: (req.postData() || '').slice(0, 1500), status: resp.status(), cuerpo,
    };
    fs.appendFileSync(LLAMADAS, JSON.stringify(reg) + '\n');
  });

  const guardar = async () => {
    try { fs.writeFileSync(SESION, JSON.stringify(await ctx.storageState()), { mode: 0o600 }); } catch (_) {}
  };
  const intervalo = setInterval(guardar, 5000);

  const p = ctx.pages()[0] || await ctx.newPage();
  const tienda = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).tienda;
  await p.goto('https://' + tienda + '.mitiendanube.com/admin');
  await new Promise(r => ctx.on('close', r));
  clearInterval(intervalo);
})();
