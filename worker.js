// Autoconfirmador Tiendanube (corre en un servidor siempre prendido; también puede correr en la Mac con launchd).
//
// Mantiene UN Chrome invisible con la sesión del panel de Tiendanube y, cada minuto:
//   1. lee los pedidos abiertos con pago pendiente (API interna del panel: /v3/orders/advanced-search);
//   2. se los manda al Apps Script del bot (accion "tn_sync") y recibe la cola de pedidos a confirmar;
//   3. marca cada uno como pagado (POST /v2/orders/{id}/mark-as-paid, lo mismo que el botón "Marcar como recibido");
//   4. avisa el resultado (accion "tn_resultado"). El Apps Script avisa en Telegram.
// La sesión se guarda en ./estado/sesion.json. Si Tiendanube la cierra, avisa por Telegram (accion "tn_sesion").
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

// Configuración: config.json en la Mac, o variables de entorno en GitHub Actions (TN_WEBAPP, TN_CLAVE, TN_TIENDA, TN_SESION).
const CFG = fs.existsSync(path.join(__dirname, 'config.json'))
  ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
  : { webapp: process.env.TN_WEBAPP, clave: process.env.TN_CLAVE, tienda: process.env.TN_TIENDA };
const UNA_VEZ = process.argv.includes('--una-vez');   // GitHub Actions: un ciclo y termina
const ESTADO = path.join(__dirname, 'estado');
const SESION = path.join(ESTADO, 'sesion.json');
const CIRRUS = 'https://cirrus.tiendanube.com';
const CADA_MS = 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
let browser, ctx, page, auth = null;

async function abrir() {
  if (!fs.existsSync(SESION) && process.env.TN_SESION) fs.writeFileSync(SESION, process.env.TN_SESION, { mode: 0o600 });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  ctx = await browser.newContext({ storageState: fs.existsSync(SESION) ? SESION : undefined });
  ctx.on('request', req => {
    if (!req.url().startsWith(CIRRUS)) return;
    const h = req.headers();
    if (h['x-access-token']) {
      auth = {};
      for (const k of Object.keys(h)) if (/^x-/.test(k)) auth[k] = h[k];
    }
  });
  page = await ctx.newPage();
}

/** Carga el panel para renovar la sesión y capturar los encabezados que usa con su API. */
async function refrescarSesion() {
  auth = null;
  await page.goto('https://' + CFG.tienda + '.mitiendanube.com/admin/orders', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 30 && !auth; i++) await page.waitForTimeout(1000);
  if (/login|ingresar/i.test(page.url()) || !auth) return false;
  fs.writeFileSync(SESION, JSON.stringify(await ctx.storageState()), { mode: 0o600 });
  return true;
}

async function cirrus(metodo, ruta, cuerpo) {
  const r = await ctx.request.fetch(CIRRUS + ruta, {
    method: metodo,
    headers: { ...auth, 'content-type': 'application/json', accept: 'application/json', referer: 'https://' + CFG.tienda + '.mitiendanube.com/' },
    data: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    timeout: 30000,
  });
  const txt = await r.text();
  if (r.status() === 401 || r.status() === 403) { const e = new Error('sesion'); e.sesion = true; throw e; }
  if (r.status() >= 400) throw new Error(metodo + ' ' + ruta + ' → ' + r.status() + ' ' + txt.slice(0, 200));
  try { return JSON.parse(txt); } catch (_) { return {}; }
}

/** Pedidos abiertos con pago pendiente (solo pagos "a convenir" / transferencia, no Pago Nube ni tarjeta). */
async function pedidosPendientes() {
  const pedidos = [];
  for (let page = 1; page <= 20; page++) {
    const d = await cirrus('POST', '/v3/orders/advanced-search',
      { page: String(page), perPage: '50', properties: ['paymentBreakdown'], status: 'open', paymentStatus: 'pending' });
    for (const o of d.results || []) {
      const pago = o.payment || {};
      if (pago.status !== 'pending') continue;
      if (!['not-provided', 'offline', 'custom'].includes(String(pago.gateway || '').toLowerCase()) &&
          !/transfer|convenir|custom|other/i.test(String(pago.gatewayMethod || ''))) continue;
      pedidos.push({
        id: String(o.id), numero: '#' + o.number, fecha: o.date, total: Number(o.total),
        nombres: [o.consumer && o.consumer.name].filter(Boolean), cuit: '',
      });
    }
    if (!d.pagination || !d.pagination.nextPage) break;
  }
  return pedidos;
}

/** Habla con el Apps Script del bot (web app con acceso "Cualquiera", protegida con la clave de config.json). */
async function webapp(cuerpo) {
  const r = await ctx.request.post(CFG.webapp, {
    data: JSON.stringify({ ...cuerpo, clave: CFG.clave }), headers: { 'content-type': 'text/plain' }, maxRedirects: 5, timeout: 60000,
  });
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch (_) {
    const e = new Error(/accounts\.google|ServiceLogin|Iniciar sesión|Sign in/i.test(txt)
      ? 'Falta la sesión de Google de Kevin en el Chrome del autoconfirmador' : 'Apps Script respondió algo raro: ' + txt.slice(0, 120));
    e.google = true;
    throw e;
  }
}

let sesionOk = false;
async function ciclo() {
  if (!sesionOk || !auth) {
    sesionOk = await refrescarSesion();
    if (!sesionOk && process.env.TN_SESION && !ciclo.probeSecreto) {
      // La sesión guardada venció: se prueba con la del secreto (por si se volvió a iniciar sesión).
      ciclo.probeSecreto = true;
      fs.writeFileSync(SESION, process.env.TN_SESION, { mode: 0o600 });
      await browser.close(); await abrir();
      sesionOk = await refrescarSesion();
    }
    if (!sesionOk) { log('sin sesión de Tiendanube'); await webapp({ accion: 'tn_sesion', ok: false }); return; }
  }
  let pedidos;
  try { pedidos = await pedidosPendientes(); }
  catch (e) {
    if (e.sesion) { sesionOk = false; return ciclo(); }
    throw e;
  }
  const r = await webapp({ accion: 'tn_sync', pedidos });
  for (const a of r.acciones || []) {
    try {
      await cirrus('POST', '/v2/orders/' + a.orderId + '/mark-as-paid', {});
      log('confirmado', a.numero);
      await webapp({ accion: 'tn_resultado', ingresoId: a.ingresoId, ok: true });
    } catch (e) {
      log('error al confirmar', a.numero, e.message);
      if (e.sesion) { sesionOk = false; return; }   // se reintenta en el próximo ciclo
      await webapp({ accion: 'tn_resultado', ingresoId: a.ingresoId, ok: false, error: e.message });
    }
  }
  log('ok · pendientes en Tiendanube:', pedidos.length, '· confirmados:', (r.acciones || []).length);
}

(async () => {
  fs.mkdirSync(ESTADO, { recursive: true, mode: 0o700 });
  await abrir();
  if (UNA_VEZ) {
    let codigo = 0;
    const vueltas = Number(process.env.TN_VUELTAS || 1);
    for (let i = 0; i < vueltas; i++) {
      try { await ciclo(); } catch (e) { log('error', e.message); codigo = 1; }
      if (i < vueltas - 1) await new Promise(r => setTimeout(r, CADA_MS));
    }
    await browser.close();
    process.exit(codigo);
  }
  let ultimaRenovacion = Date.now();
  for (;;) {
    try {
      if (Date.now() - ultimaRenovacion > 30 * 60 * 1000) { sesionOk = false; ultimaRenovacion = Date.now(); } // renueva cada 30 min
      await ciclo();
    } catch (e) {
      log('error', e.message);
      if (!browser.isConnected()) { try { await abrir(); } catch (_) {} sesionOk = false; }
    }
    await new Promise(r => setTimeout(r, CADA_MS));
  }
})();
