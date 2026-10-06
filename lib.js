// Lógica pura (sin base de datos ni red) para poder probarla de forma aislada.
const crypto = require('crypto');

const TZ = 'America/Mexico_City';
const MX_OFFSET = '-06:00'; // México no usa horario de verano desde 2022

// ─── Fechas ───────────────────────────────────────────────────────────────────
function diaMX(fecha = new Date()) {
  return new Date(fecha).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function ultimosDias(n, hasta = new Date()) {
  const base = new Date(diaMX(hasta) + 'T12:00:00' + MX_OFFSET).getTime();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(diaMX(new Date(base - i * 86400000)));
  return out;
}

function inicioDiaMX(fecha = new Date()) {
  return new Date(diaMX(fecha) + 'T00:00:00' + MX_OFFSET);
}

function diaDeBoleto(b) {
  if (b.ts) return diaMX(b.ts);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(b.fecha || '');
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// ─── Texto ────────────────────────────────────────────────────────────────────
function escMd(s) {
  return String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
}

function fmtUsd(n) {
  n = Number(n) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function barra(pct, largo = 10) {
  const llenos = Math.max(0, Math.min(largo, Math.round((pct / 100) * largo)));
  return '▰'.repeat(llenos) + '▱'.repeat(largo - llenos);
}

const MEDALLAS = ['🥇', '🥈', '🥉'];
const medalla = i => MEDALLAS[i] || '🏅';

// ─── Premios ──────────────────────────────────────────────────────────────────
function usdDe(p) {
  if (p.montoUsd != null && !isNaN(p.montoUsd)) return Number(p.montoUsd);
  if (p.monto != null) return p.moneda === 'USD' ? Number(p.monto) : Number(p.monto) / 50; // legado: Stars
  return 0;
}

function nombrePremioDefault(i) {
  return ['1er Premio', '2do Premio', '3er Premio'][i] || `${i + 1}° Premio`;
}

function normalizarPremiosSalida(premios) {
  return (premios || []).map((p, i) => ({
    lugar: i + 1,
    descripcion: p.descripcion || nombrePremioDefault(i),
    montoUsd: usdDe(p),
    moneda: 'USD'
  }));
}

function parsePremiosEntrada(arr) {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > 10) return { error: 'Debes definir entre 1 y 10 premios' };
  const premios = [];
  for (let i = 0; i < arr.length; i++) {
    const monto = Math.round(Number(arr[i].montoUsd) * 100) / 100;
    if (!isFinite(monto) || monto <= 0 || monto > 100000) return { error: `Monto inválido en el premio ${i + 1}` };
    const descripcion = String(arr[i].descripcion || '').trim().slice(0, 60) || nombrePremioDefault(i);
    premios.push({ lugar: i + 1, descripcion, montoUsd: monto, moneda: 'USD' });
  }
  return { premios };
}

// ─── Telegram WebApp: validación de initData ─────────────────────────────────
function validarInitData(initData, botToken, maxEdadSeg = 172800) {
  try {
    if (!initData || !botToken) return { ok: false };
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false };
    params.delete('hash');
    const dcs = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secreto = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secreto).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
    const authDate = parseInt(params.get('auth_date'), 10);
    if (!authDate || Date.now() / 1000 - authDate > maxEdadSeg) return { ok: false };
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return { ok: false };
    return { ok: true, user };
  } catch (e) {
    return { ok: false };
  }
}

// ─── Sorteo ───────────────────────────────────────────────────────────────────
// Cada ganador sale de un boleto al azar; más boletos = más probabilidad.
// Un usuario solo puede ganar un premio. Nunca se queda en un bucle si hay pocos usuarios.
function elegirGanadores(boletos, premios, randomInt = crypto.randomInt) {
  let pool = (boletos || []).filter(b => b.pagado !== false);
  const ganadores = [];
  for (let i = 0; i < premios.length && pool.length > 0; i++) {
    const boleto = pool[randomInt(pool.length)];
    ganadores.push({ boleto, premio: premios[i] });
    pool = pool.filter(b => b.userId !== boleto.userId);
  }
  return ganadores;
}

// ─── Estadísticas ─────────────────────────────────────────────────────────────
function origenBoleto(b) {
  switch (b.motivo) {
    case 'ad_watched': return 'ad';
    case 'canal': return 'canal';
    case 'referido': return 'referido';
    case 'bonus5':
    case 'bonus10': return 'bonus';
    case 'regalo': return 'regalo';
    default: return b.esBoletoGratis === false ? 'compra' : 'otro';
  }
}

function resumenBoletos(boletos, dias = 14, hasta = new Date()) {
  const porOrigen = { ad: 0, canal: 0, referido: 0, bonus: 0, regalo: 0, compra: 0, otro: 0 };
  const listaDias = ultimosDias(dias, hasta);
  const porDiaMap = Object.fromEntries(listaDias.map(d => [d, 0]));
  const porUsuario = new Map();
  for (const b of boletos || []) {
    porOrigen[origenBoleto(b)]++;
    const d = diaDeBoleto(b);
    if (d in porDiaMap) porDiaMap[d]++;
    const u = porUsuario.get(b.userId) || { userId: b.userId, username: b.username || '', boletos: 0 };
    u.boletos++;
    if (b.username) u.username = b.username;
    porUsuario.set(b.userId, u);
  }
  const top = [...porUsuario.values()].sort((a, b) => b.boletos - a.boletos).slice(0, 5);
  return {
    porOrigen,
    porDia: listaDias.map(d => ({ dia: d, n: porDiaMap[d] })),
    participantes: porUsuario.size,
    top,
    conteoPorUsuario: porUsuario
  };
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  TZ, diaMX, ultimosDias, inicioDiaMX, diaDeBoleto,
  escMd, fmtUsd, barra, medalla,
  usdDe, normalizarPremiosSalida, parsePremiosEntrada, nombrePremioDefault,
  validarInitData, elegirGanadores, origenBoleto, resumenBoletos, redondear
};
