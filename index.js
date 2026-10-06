const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const L = require('./lib');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CANAL_ID = process.env.CANAL_ID || '@LuckyStarsOficial';
const MONGODB_URI = process.env.MONGODB_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cultogore.github.io/luckystars-frontend/';
const BOT_USERNAME = process.env.BOT_USERNAME || 'LuckyStarsOficial_bot';
const PORT = process.env.PORT || 3000;

let db;

// ─── CONFIGURACIÓN (editable desde el panel admin) ───────────────────────────
const CONFIG_DEFAULT = { adLimitDiario: 5, cooldownSeg: 15, cpmUsd: 3, avisoBienvenida: '' };
let configCache = { at: 0, value: { ...CONFIG_DEFAULT } };

async function getConfig(forzar = false) {
  if (!forzar && Date.now() - configCache.at < 15000) return configCache.value;
  const doc = (await db.collection('config').findOne({ _id: 'main' })) || {};
  delete doc._id;
  configCache = { at: Date.now(), value: { ...CONFIG_DEFAULT, ...doc } };
  return configCache.value;
}

// ─── BASE DE DATOS ───────────────────────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('luckystars');
  console.log('MongoDB conectado');

  try {
    await db.collection('usuarios').createIndex({ userId: 1 }, { unique: true });
  } catch (e) { console.error('Índice usuarios:', e.message); }
  try {
    await db.collection('ads').createIndex({ day: 1 });
  } catch (e) { console.error('Índice ads:', e.message); }

  // Migración: contador de boletos para numeración atómica
  const activo = await db.collection('sorteos').findOne({ activo: true });
  if (activo && activo.contador == null) {
    const maxNum = (activo.boletos || []).reduce((m, b) => Math.max(m, parseInt(b.numero, 10) || 0), 0);
    await db.collection('sorteos').updateOne({ _id: activo._id }, { $set: { contador: Math.max(maxNum, (activo.boletos || []).length) } });
    console.log('Contador de boletos inicializado');
  }
}

async function getSorteoActivo() {
  return db.collection('sorteos').findOne({ activo: true });
}

async function getUsuario(userId) {
  userId = String(userId);
  return db.collection('usuarios').findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        username: '', firstName: '', referidoPor: null, referidosQueCompraron: 0, joinedCanal: false,
        totalComprado: 0, boletosGratisCanal: false, adsHoy: 0, adsTotal: 0, ultimoAdDia: '',
        fechaRegistro: new Date().toISOString()
      }
    },
    { upsert: true, returnDocument: 'after' }
  );
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function callTelegram(method, data) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return res.json();
}

async function verificarMembresia(userId) {
  try {
    const res = await callTelegram('getChatMember', { chat_id: CANAL_ID, user_id: userId });
    if (res.ok) return ['member', 'administrator', 'creator'].includes(res.result.status);
    return false;
  } catch (e) { return false; }
}

async function enviarMensaje(chatId, text, extra = {}) {
  return callTelegram('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function avisar(userId, text) {
  try { await enviarMensaje(userId, text); } catch (e) { /* el usuario pudo bloquear el bot */ }
}

// Valida que la petición venga realmente de la Mini App de Telegram
function autenticarWebApp(initData) {
  return L.validarInitData(initData, BOT_TOKEN);
}

// ─── BOLETOS ─────────────────────────────────────────────────────────────────
// Numeración atómica con contador + tope por meta. Si este boleto llena el sorteo, se sortea solo.
async function darBoleto(userId, motivo, usuario) {
  const u = usuario || await getUsuario(userId);
  const s = await db.collection('sorteos').findOneAndUpdate(
    { activo: true, $expr: { $lt: [{ $size: '$boletos' }, '$metaBoletos'] } },
    { $inc: { contador: 1 } },
    { returnDocument: 'after', projection: { contador: 1 } }
  );
  if (!s) return { error: 'No hay boletos disponibles: el sorteo está lleno o no hay sorteo activo' };

  const ahora = new Date();
  const numero = String(s.contador).padStart(3, '0');
  const boleto = {
    numero, userId: String(userId), username: u.username || u.firstName || '',
    fecha: ahora.toLocaleDateString('es-MX', { timeZone: L.TZ }), ts: ahora.toISOString(),
    esBoletoGratis: true, pagado: true, motivo
  };
  await db.collection('sorteos').updateOne({ _id: s._id }, { $push: { boletos: boleto } });

  const lleno = await db.collection('sorteos').countDocuments({ _id: s._id, activo: true, $expr: { $gte: [{ $size: '$boletos' }, '$metaBoletos'] } });
  if (lleno) realizarSorteo(s._id).catch(e => console.error('Error en sorteo automático:', e));
  return { ok: true, numero, lleno: !!lleno };
}

async function reclamarBoletoCanal(userId) {
  const usuario = await getUsuario(userId);
  if (usuario.baneado) return { error: 'Cuenta suspendida' };
  const sorteo = await getSorteoActivo();
  if (!sorteo) return { error: 'No hay sorteo activo' };
  if (usuario.boletosGratisCanal) return { error: 'Ya reclamaste tu boleto gratis por unirte al canal' };
  if (!(await verificarMembresia(userId))) return { error: 'Únete a @LuckyStarsOficial primero', noMiembro: true };
  // Marca primero para evitar doble reclamo en peticiones simultáneas
  const marca = await db.collection('usuarios').updateOne({ userId: String(userId), boletosGratisCanal: { $ne: true } }, { $set: { boletosGratisCanal: true, joinedCanal: true } });
  if (!marca.modifiedCount) return { error: 'Ya reclamaste tu boleto gratis por unirte al canal' };
  const r = await darBoleto(userId, 'canal', usuario);
  if (r.error) {
    await db.collection('usuarios').updateOne({ userId: String(userId) }, { $set: { boletosGratisCanal: false } });
    return r;
  }
  return r;
}

// Recompensa al que invitó cuando su referido ve su primer anuncio
async function procesarReferido(referido) {
  if (!referido.referidoPor || referido.referidoRecompensado) return;
  const marca = await db.collection('usuarios').updateOne({ userId: referido.userId, referidoRecompensado: { $ne: true } }, { $set: { referidoRecompensado: true } });
  if (!marca.modifiedCount) return;

  const referidor = await db.collection('usuarios').findOneAndUpdate(
    { userId: referido.referidoPor, baneado: { $ne: true } },
    { $inc: { referidosQueCompraron: 1 } }, // se conserva el nombre del campo: ahora cuenta referidos activos
    { returnDocument: 'after' }
  );
  if (!referidor) return;

  const quien = referido.username ? '@' + L.escMd(referido.username) : L.escMd(referido.firstName || 'Tu amigo');
  const r = await darBoleto(referidor.userId, 'referido', referidor);
  if (r.ok) await avisar(referidor.userId, `🎉 *¡Boleto gratis ganado!*\n\n${quien} vio su primer anuncio gracias a tu invitación.\n\n🎟 Boleto #${r.numero} es tuyo. ¡Buena suerte!`);

  const n = referidor.referidosQueCompraron;
  if (n === 5) {
    for (let i = 0; i < 2; i++) await darBoleto(referidor.userId, 'bonus5', referidor);
    await avisar(referidor.userId, '🏆 *¡BONUS!* 5 referidos = *2 boletos extra* 🎟');
  }
  if (n === 10) {
    for (let i = 0; i < 5; i++) await darBoleto(referidor.userId, 'bonus10', referidor);
    await avisar(referidor.userId, '🌟 *¡MEGA BONUS!* 10 referidos = *5 boletos extra* 🎟');
  }
}

// ─── SORTEO ──────────────────────────────────────────────────────────────────
async function realizarSorteo(sorteoId) {
  // "Reclama" el sorteo de forma atómica: si ya se hizo, no hace nada
  const s = await db.collection('sorteos').findOneAndUpdate(
    { _id: sorteoId, activo: true },
    { $set: { activo: false, fechaFin: new Date().toISOString() } },
    { returnDocument: 'after' }
  );
  if (!s) return null;

  const premios = L.normalizarPremiosSalida(s.premios);
  const ganadores = L.elegirGanadores(s.boletos, premios).map(({ boleto, premio }) => ({
    numero: boleto.numero, userId: boleto.userId, username: boleto.username || '',
    premio, pagado: false, txid: '', nota: '', pagadoEn: null
  }));
  const participantes = new Set(s.boletos.map(b => b.userId)).size;

  await db.collection('sorteos').updateOne({ _id: s._id }, { $set: { ganadores } });
  await db.collection('historial').insertOne({
    sorteoId: s._id, titulo: s.titulo, ganadores, totalBoletos: s.boletos.length, participantes, fecha: new Date().toISOString()
  });

  for (const g of ganadores) {
    await avisar(g.userId,
      `🏆 *¡FELICIDADES, GANASTE!*\n\n${L.medalla(g.premio.lugar - 1)} ${L.escMd(g.premio.descripcion)}\n💵 *$${L.fmtUsd(g.premio.montoUsd)} USD*\n🎟 Boleto #${g.numero}\n\n` +
      `💳 *Para recibir tu premio* registra tu wallet con:\n\`/wallet USDT TRC20 TU_DIRECCION\`\n(cambia la red y la dirección por las tuyas)\n\nTe lo enviaremos en cuanto la registres. ¡Gracias por jugar! ⭐`);
  }
  return { ganadores };
}

function textoPremios(sorteo) {
  return L.normalizarPremiosSalida(sorteo.premios).map((p, i) => `${L.medalla(i)} ${L.escMd(p.descripcion)}: *$${L.fmtUsd(p.montoUsd)} USD*`).join('\n');
}

function fechaLarga(iso) {
  return new Date(iso).toLocaleString('es-MX', { timeZone: L.TZ, dateStyle: 'long', timeStyle: 'short' });
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    await procesarUpdate(req.body);
  } catch (e) {
    console.error('Error en webhook:', e);
  }
  res.sendStatus(200); // siempre 200 para que Telegram no reintente
});

async function procesarUpdate(update) {
  if (update.pre_checkout_query) {
    await callTelegram('answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id, ok: false,
      error_message: 'Las compras ya no están disponibles: ahora los boletos son gratis viendo anuncios.'
    });
    return;
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    await callTelegram('answerCallbackQuery', { callback_query_id: cb.id });
    const chatId = cb.message.chat.id;
    if (cb.data && cb.data.startsWith('ref_')) {
      await enviarInfoReferidos(chatId, cb.data.replace('ref_', ''));
    } else if (cb.data === 'misboletos') {
      await enviarMisBoletosMsg(chatId, String(cb.from.id));
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;
  const userId = String(msg.from.id);
  const usuario = await getUsuario(userId);
  await db.collection('usuarios').updateOne({ userId }, { $set: { username: msg.from.username || '', firstName: msg.from.first_name || '' } });

  if (!msg.text) return;
  const [cmdRaw, ...resto] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  if (cmd === '/start') {
    const param = resto[0];
    if (param && param.startsWith('ref_')) {
      const referidorId = param.replace('ref_', '');
      if (referidorId !== userId && !usuario.referidoPor) {
        await db.collection('usuarios').updateOne({ userId }, { $set: { referidoPor: referidorId } });
      }
    }
    await enviarBienvenida(msg.chat.id, userId);
  } else if (cmd === '/sorteo') await enviarEstadoSorteo(msg.chat.id);
  else if (cmd === '/misboletos') await enviarMisBoletosMsg(msg.chat.id, userId);
  else if (cmd === '/referidos') await enviarInfoReferidos(msg.chat.id, userId);
  else if (cmd === '/gratis') await procesarBoletosGratis(msg.chat.id, userId);
  else if (cmd === '/wallet') await registrarWallet(msg.chat.id, userId, resto.join(' ').trim());
}

async function botonesPrincipales(userId) {
  return {
    inline_keyboard: [
      [{ text: '📺 Ganar boletos gratis', web_app: { url: FRONTEND_URL } }],
      [{ text: '🎟 Mis boletos', callback_data: 'misboletos' }, { text: '⭐ Canal Oficial', url: 'https://t.me/LuckyStarsOficial' }],
      [{ text: '👥 Invitar Amigos', callback_data: 'ref_' + userId }]
    ]
  };
}

async function enviarBienvenida(chatId, userId) {
  const sorteo = await getSorteoActivo();
  const cfg = await getConfig();
  let t = '⭐ *Bienvenido a Lucky Stars*\n\nSorteos *100% GRATIS* con premios en dinero real 💵\n\n';
  if (sorteo) {
    const n = sorteo.boletos.length;
    const pct = Math.round((n / sorteo.metaBoletos) * 100);
    t += `🎯 *Sorteo activo:* ${L.escMd(sorteo.titulo)}\n`;
    t += `🎟 *Boletos repartidos:* ${n}/${sorteo.metaBoletos}\n${L.barra(pct)} ${pct}%\n`;
    if (sorteo.fechaSorteo) t += `⏰ *Sorteo:* ${fechaLarga(sorteo.fechaSorteo)}\n`;
    t += `\n🏆 *Premios:*\n${textoPremios(sorteo)}\n`;
  } else {
    t += '🔔 Por ahora no hay un sorteo activo. ¡Vuelve pronto!\n';
  }
  t += `\n📺 *Cómo conseguir boletos (gratis):*\n`;
  t += `• Mira un anuncio corto = *1 boleto* (hasta ${cfg.adLimitDiario} al día)\n`;
  t += `• Únete a @LuckyStarsOficial y escribe /gratis = *1 boleto*\n`;
  t += `• Invita amigos = *boletos extra* (/referidos)\n`;
  if (cfg.avisoBienvenida) t += `\n📢 ${L.escMd(cfg.avisoBienvenida)}\n`;
  t += '\nUsa el botón de abajo para participar 👇';
  await enviarMensaje(chatId, t, { reply_markup: await botonesPrincipales(userId) });
}

async function procesarBoletosGratis(chatId, userId) {
  const r = await reclamarBoletoCanal(userId);
  if (r.noMiembro) {
    await enviarMensaje(chatId, `❌ No eres miembro de @LuckyStarsOficial.\n\nÚnete primero y luego escribe /gratis.`, {
      reply_markup: { inline_keyboard: [[{ text: '⭐ Unirse al Canal', url: 'https://t.me/LuckyStarsOficial' }]] }
    });
  } else if (r.error) {
    await enviarMensaje(chatId, `⚠️ ${L.escMd(r.error)}.`);
  } else {
    await enviarMensaje(chatId, `✅ *¡Boleto gratis reclamado!*\n\nTu boleto #${r.numero} está en el sorteo.\n\n¡Buena suerte! ⭐`);
  }
}

async function registrarWallet(chatId, userId, texto) {
  const usuario = await getUsuario(userId);
  if (!texto) {
    const actual = usuario.wallet ? `Tu wallet registrada: \`${usuario.wallet}\`\n\n` : '';
    await enviarMensaje(chatId, `💳 *Wallet para recibir premios*\n\n${actual}Para registrarla o cambiarla escribe:\n\`/wallet USDT TRC20 TU_DIRECCION\``);
    return;
  }
  if (!/^[A-Za-z0-9 _:.\-]{10,200}$/.test(texto)) {
    await enviarMensaje(chatId, '❌ Wallet no válida. Usa solo letras, números y espacios.\n\nEjemplo:\n`/wallet USDT TRC20 TU_DIRECCION`');
    return;
  }
  await db.collection('usuarios').updateOne({ userId }, { $set: { wallet: texto, walletFecha: new Date().toISOString() } });
  await enviarMensaje(chatId, `✅ *Wallet registrada*\n\n\`${texto}\`\n\nSi ganas, tu premio se enviará a esta dirección.`);
}

async function enviarEstadoSorteo(chatId) {
  const sorteo = await getSorteoActivo();
  if (!sorteo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  const n = sorteo.boletos.length;
  const pct = Math.round((n / sorteo.metaBoletos) * 100);
  let t = `📊 *${L.escMd(sorteo.titulo)}*\n\n🎟 Boletos repartidos: ${n}/${sorteo.metaBoletos}\n${L.barra(pct)} ${pct}%\n⏳ Restantes: ${sorteo.metaBoletos - n}\n`;
  if (sorteo.fechaSorteo) t += `⏰ Sorteo: ${fechaLarga(sorteo.fechaSorteo)}\n`;
  t += `\n🏆 *Premios:*\n${textoPremios(sorteo)}\n\n📺 Mira anuncios en la app para conseguir boletos gratis.`;
  await enviarMensaje(chatId, t, { reply_markup: { inline_keyboard: [[{ text: '📺 Ganar boletos gratis', web_app: { url: FRONTEND_URL } }]] } });
}

async function enviarMisBoletosMsg(chatId, userId) {
  const sorteo = await getSorteoActivo();
  if (!sorteo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  const mis = sorteo.boletos.filter(b => b.userId === userId);
  if (mis.length === 0) {
    await enviarMensaje(chatId, '❌ Aún no tienes boletos en este sorteo.\n\n📺 Mira un anuncio en la app y consigue el primero gratis.', {
      reply_markup: { inline_keyboard: [[{ text: '📺 Ganar boletos gratis', web_app: { url: FRONTEND_URL } }]] }
    });
    return;
  }
  const lista = mis.slice(-60).map(b => '#' + b.numero).join('  ');
  const extra = mis.length > 60 ? `\n(mostrando los últimos 60)` : '';
  const prob = ((mis.length / sorteo.boletos.length) * 100).toFixed(1);
  await enviarMensaje(chatId, `🎟 *Tus boletos:*\n\n${lista}${extra}\n\nTotal: *${mis.length}* boleto(s)\n📈 Tienes el ${prob}% de los boletos repartidos.\n\n¡Buena suerte! ⭐`);
}

async function enviarInfoReferidos(chatId, userId) {
  const usuario = await getUsuario(userId);
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;
  await enviarMensaje(chatId,
    `👥 *Tu sistema de referidos*\n\n🔗 *Tu link:*\n\`${link}\`\n\n✅ Amigos que ya vieron su primer anuncio: *${usuario.referidosQueCompraron || 0}*\n\n` +
    `🎁 *Recompensas:*\n• Cada amigo que entre con tu link y vea su primer anuncio = *1 boleto gratis*\n• 5 amigos = *2 boletos extra*\n• 10 amigos = *5 boletos extra*\n\n¡Comparte y gana!`);
}

// ─── API PÚBLICA ─────────────────────────────────────────────────────────────
app.get('/api/sorteo', async (req, res) => {
  try {
    const sorteo = await getSorteoActivo();
    if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
    const cfg = await getConfig();
    const vendidos = sorteo.boletos.length;
    res.json({
      id: sorteo._id, titulo: sorteo.titulo, activo: sorteo.activo, metaBoletos: sorteo.metaBoletos,
      vendidos, restantes: sorteo.metaBoletos - vendidos, porcentaje: Math.round((vendidos / sorteo.metaBoletos) * 100),
      participantes: new Set(sorteo.boletos.map(b => b.userId)).size,
      premios: L.normalizarPremiosSalida(sorteo.premios), fechaSorteo: sorteo.fechaSorteo || null, adLimite: cfg.adLimitDiario
    });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

app.get('/api/mis-boletos/:userId', async (req, res) => {
  try {
    const sorteo = await getSorteoActivo();
    if (!sorteo) return res.json([]);
    res.json(sorteo.boletos.filter(b => b.userId === req.params.userId).map(b => ({ ...b, origen: L.origenBoleto(b) })));
  } catch (e) { res.status(500).json([]); }
});

app.get('/api/usuario/:userId', async (req, res) => {
  try {
    const u = await getUsuario(req.params.userId);
    res.json({
      userId: u.userId, username: u.username, firstName: u.firstName,
      referidosQueCompraron: u.referidosQueCompraron || 0,
      linkReferido: `https://t.me/${BOT_USERNAME}?start=ref_${u.userId}`
    });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

app.post('/api/reclamar-gratis', async (req, res) => {
  try {
    const auth = autenticarWebApp(req.body.initData);
    if (!auth.ok) return res.status(401).json({ error: 'Sesión inválida. Abre la app desde Telegram.' });
    const r = await reclamarBoletoCanal(String(auth.user.id));
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error del servidor' }); }
});

// ─── RECOMPENSA POR ANUNCIOS ─────────────────────────────────────────────────
app.get('/api/ad-status/:userId', async (req, res) => {
  try {
    const cfg = await getConfig();
    const usuario = await getUsuario(req.params.userId);
    const adsHoy = usuario.ultimoAdDia === L.diaMX() ? (usuario.adsHoy || 0) : 0;
    res.json({ adsHoy, limite: cfg.adLimitDiario, restantes: Math.max(0, cfg.adLimitDiario - adsHoy) });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

app.post('/api/ad-reward', async (req, res) => {
  try {
    const auth = autenticarWebApp(req.body.initData);
    if (!auth.ok) return res.status(401).json({ error: 'Sesión inválida. Abre la app desde Telegram.' });
    const userId = String(auth.user.id);
    const cfg = await getConfig();
    const hoy = L.diaMX();
    const ahora = Date.now();

    await getUsuario(userId);
    // Reinicia el contador diario si cambió el día (hora de México)
    await db.collection('usuarios').updateOne({ userId, ultimoAdDia: { $ne: hoy } }, { $set: { ultimoAdDia: hoy, adsHoy: 0 } });

    const datos = { ultimoAdTs: ahora, ultimoAdDia: hoy };
    if (auth.user.username) datos.username = auth.user.username;
    if (auth.user.first_name) datos.firstName = auth.user.first_name;

    // Reserva el anuncio de forma atómica: respeta límite diario, cooldown y suspensión
    const usuario = await db.collection('usuarios').findOneAndUpdate(
      {
        userId, baneado: { $ne: true }, adsHoy: { $lt: cfg.adLimitDiario },
        $or: [{ ultimoAdTs: { $exists: false } }, { ultimoAdTs: { $lte: ahora - cfg.cooldownSeg * 1000 } }]
      },
      { $inc: { adsHoy: 1, adsTotal: 1 }, $set: datos },
      { returnDocument: 'after' }
    );

    if (!usuario) {
      const u = await getUsuario(userId);
      if (u.baneado) return res.status(403).json({ error: 'Cuenta suspendida' });
      if ((u.adsHoy || 0) >= cfg.adLimitDiario) return res.json({ error: 'Límite diario alcanzado', adsHoy: u.adsHoy, limite: cfg.adLimitDiario, restantes: 0 });
      const espera = Math.max(1, Math.ceil(((u.ultimoAdTs || 0) + cfg.cooldownSeg * 1000 - ahora) / 1000));
      return res.json({ error: `Espera ${espera} s antes del siguiente anuncio`, espera });
    }

    const r = await darBoleto(userId, 'ad_watched', usuario);
    if (r.error) {
      await db.collection('usuarios').updateOne({ userId }, { $inc: { adsHoy: -1, adsTotal: -1 }, $unset: { ultimoAdTs: '' } });
      return res.json({ error: r.error });
    }

    db.collection('ads').insertOne({ userId, ts: new Date(), day: hoy }).catch(() => {});
    procesarReferido(usuario).catch(e => console.error('Error en referido:', e));

    res.json({ ok: true, numero: r.numero, lleno: r.lleno, adsHoy: usuario.adsHoy, limite: cfg.adLimitDiario, restantes: cfg.adLimitDiario - usuario.adsHoy });
  } catch (e) {
    console.error('Error en ad-reward:', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─── ADMIN API ───────────────────────────────────────────────────────────────
const intentosFallidos = new Map(); // ip → { n, hasta }
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function admin(handler) {
  return async (req, res) => {
    try {
      if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Falta configurar ADMIN_PASSWORD en el servidor' });
      const reg = intentosFallidos.get(req.ip);
      if (reg && reg.n >= 10 && Date.now() < reg.hasta) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      const ok = crypto.timingSafeEqual(sha(req.headers['x-admin-password'] || ''), sha(ADMIN_PASSWORD));
      if (!ok) {
        const nuevo = reg && Date.now() < reg.hasta ? { n: reg.n + 1, hasta: reg.hasta } : { n: 1, hasta: Date.now() + 15 * 60000 };
        intentosFallidos.set(req.ip, nuevo);
        return res.status(401).json({ error: 'No autorizado' });
      }
      intentosFallidos.delete(req.ip);
      await handler(req, res);
    } catch (e) {
      console.error('Error admin:', e);
      res.status(500).json({ error: 'Error del servidor: ' + e.message });
    }
  };
}

function fechaFutura(valor) {
  if (valor === null || valor === '' || valor === undefined) return { valor: null };
  const d = new Date(valor);
  if (isNaN(d.getTime())) return { error: 'Fecha de sorteo inválida' };
  return { valor: d.toISOString() };
}

app.get('/admin/stats', admin(async (req, res) => {
  const cfg = await getConfig(true);
  const sorteo = await getSorteoActivo();
  const hoy = L.diaMX();
  const dias14 = L.ultimosDias(14);

  const [totalUsuarios, usuariosHoy, baneados, adsAgg, unicosHoy, historial] = await Promise.all([
    db.collection('usuarios').countDocuments(),
    db.collection('usuarios').countDocuments({ fechaRegistro: { $gte: L.inicioDiaMX().toISOString() } }),
    db.collection('usuarios').countDocuments({ baneado: true }),
    db.collection('ads').aggregate([{ $match: { day: { $gte: dias14[0] } } }, { $group: { _id: '$day', n: { $sum: 1 } } }]).toArray(),
    db.collection('ads').distinct('userId', { day: hoy }),
    db.collection('historial').find({}, { projection: { ganadores: 1, cancelado: 1 } }).toArray()
  ]);

  const adsMap = Object.fromEntries(adsAgg.map(a => [a._id, a.n]));
  const adsPorDia = dias14.map(d => ({ dia: d, n: adsMap[d] || 0 }));
  const suma = arr => arr.reduce((t, x) => t + x.n, 0);
  const anuncios = {
    hoy: adsMap[hoy] || 0, ayer: adsPorDia[adsPorDia.length - 2].n,
    ultimos7: suma(adsPorDia.slice(-7)), ultimos14: suma(adsPorDia),
    unicosHoy: unicosHoy.length, porDia: adsPorDia
  };
  const porMil = n => L.redondear((n * cfg.cpmUsd) / 1000);

  let pendientes = 0, pendientesUsd = 0, pagadoUsd = 0;
  for (const h of historial) for (const g of h.ganadores || []) {
    if (g.pagado) pagadoUsd += g.premio.montoUsd; else { pendientes++; pendientesUsd += g.premio.montoUsd; }
  }

  let activo = null, boletosInfo = { porOrigen: {}, porDia: dias14.map(d => ({ dia: d, n: 0 })), participantes: 0, top: [] };
  if (sorteo) {
    boletosInfo = L.resumenBoletos(sorteo.boletos);
    const premios = L.normalizarPremiosSalida(sorteo.premios);
    const premioTotalUsd = L.redondear(premios.reduce((t, p) => t + p.montoUsd, 0));
    const vendidos = sorteo.boletos.length;
    activo = {
      id: sorteo._id, titulo: sorteo.titulo, vendidos, metaBoletos: sorteo.metaBoletos,
      porcentaje: Math.round((vendidos / sorteo.metaBoletos) * 100), premios, premioTotalUsd,
      fechaSorteo: sorteo.fechaSorteo || null, fechaCreacion: sorteo.fechaCreacion, participantes: boletosInfo.participantes,
      boletosPorUsuario: boletosInfo.participantes ? L.redondear(vendidos / boletosInfo.participantes) : 0
    };
  }

  res.json({
    hoy, config: cfg, sorteoActivo: activo,
    totales: {
      usuarios: totalUsuarios, usuariosHoy, baneados, sorteosRealizados: historial.filter(h => !h.cancelado).length,
      pagosPendientes: pendientes, pagosPendientesUsd: L.redondear(pendientesUsd), pagadoUsd: L.redondear(pagadoUsd)
    },
    porOrigen: boletosInfo.porOrigen, boletosPorDia: boletosInfo.porDia, top: boletosInfo.top,
    anuncios,
    ingresos: {
      cpmUsd: cfg.cpmUsd, hoyUsd: porMil(anuncios.hoy), ultimos7Usd: porMil(anuncios.ultimos7), ultimos14Usd: porMil(anuncios.ultimos14),
      premiosSorteoUsd: activo ? activo.premioTotalUsd : 0,
      gananciaEstimadaUsd: activo ? L.redondear(porMil(anuncios.ultimos14) - activo.premioTotalUsd) : null
    }
  });
}));

app.get('/admin/boletos', admin(async (req, res) => {
  const sorteo = await getSorteoActivo();
  if (!sorteo) return res.json({ total: 0, page: 1, pages: 1, items: [] });
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^[#@]/, '');
  const origen = String(req.query.origen || '');
  let items = sorteo.boletos.map(b => ({ ...b, origen: L.origenBoleto(b) }));
  if (origen) items = items.filter(b => b.origen === origen);
  if (q) items = items.filter(b => (b.username || '').toLowerCase().includes(q) || b.numero.includes(q) || b.userId === q);
  items.reverse(); // más recientes primero
  const total = items.length;
  const todo = req.query.all === '1';
  const limit = todo ? total || 1 : Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  res.json({ total, page, pages, items: items.slice((page - 1) * limit, page * limit) });
}));

app.get('/admin/usuarios', admin(async (req, res) => {
  const sorteo = await getSorteoActivo();
  const conteo = sorteo ? L.resumenBoletos(sorteo.boletos).conteoPorUsuario : new Map();
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  const orden = String(req.query.orden || 'recientes');
  const limit = 25;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filtro = {};
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filtro.$or = [{ username: re }, { firstName: re }, { userId: q }];
  }
  if (req.query.baneados === '1') filtro.baneado = true;

  let docs, total;
  if (orden === 'boletos') {
    const ids = [...conteo.values()].sort((a, b) => b.boletos - a.boletos).map(u => u.userId);
    const candidatos = await db.collection('usuarios').find({ ...filtro, userId: { $in: ids } }).toArray();
    candidatos.sort((a, b) => (conteo.get(b.userId)?.boletos || 0) - (conteo.get(a.userId)?.boletos || 0));
    total = candidatos.length;
    docs = candidatos.slice((page - 1) * limit, page * limit);
  } else {
    const sort = orden === 'anuncios' ? { adsTotal: -1 } : { fechaRegistro: -1 };
    total = await db.collection('usuarios').countDocuments(filtro);
    docs = await db.collection('usuarios').find(filtro).sort(sort).skip((page - 1) * limit).limit(limit).toArray();
  }
  res.json({
    total, page, pages: Math.max(1, Math.ceil(total / limit)),
    items: docs.map(u => ({
      userId: u.userId, username: u.username || '', firstName: u.firstName || '', fechaRegistro: u.fechaRegistro,
      boletos: conteo.get(u.userId)?.boletos || 0, adsTotal: u.adsTotal || 0, referidos: u.referidosQueCompraron || 0,
      referidoPor: u.referidoPor || null, baneado: !!u.baneado, wallet: u.wallet || ''
    }))
  });
}));

app.get('/admin/historial', admin(async (req, res) => {
  const docs = await db.collection('historial').find({}).sort({ fecha: -1 }).limit(50).toArray();
  const ids = [...new Set(docs.flatMap(h => (h.ganadores || []).map(g => g.userId)))];
  const usuarios = await db.collection('usuarios').find({ userId: { $in: ids } }, { projection: { userId: 1, wallet: 1, username: 1, firstName: 1 } }).toArray();
  const mapa = Object.fromEntries(usuarios.map(u => [u.userId, u]));
  res.json(docs.map(h => ({
    id: String(h._id), titulo: h.titulo, fecha: h.fecha, cancelado: !!h.cancelado,
    totalBoletos: h.totalBoletos || 0, participantes: h.participantes || 0,
    ganadores: (h.ganadores || []).map(g => {
      const premio = L.normalizarPremiosSalida([g.premio || {}])[0];
      return { ...g, premio: { ...premio, lugar: g.premio?.lugar || 1 }, wallet: mapa[g.userId]?.wallet || '', username: g.username || mapa[g.userId]?.username || '', nombre: mapa[g.userId]?.firstName || '' };
    })
  })));
}));

app.post('/admin/ganador-pago', admin(async (req, res) => {
  const { historialId, userId, pagado, txid, nota, notificar } = req.body;
  let oid;
  try { oid = new ObjectId(historialId); } catch (e) { return res.status(400).json({ error: 'ID inválido' }); }
  const cambios = {
    'ganadores.$[g].pagado': !!pagado, 'ganadores.$[g].txid': String(txid || '').slice(0, 200),
    'ganadores.$[g].nota': String(nota || '').slice(0, 300), 'ganadores.$[g].pagadoEn': pagado ? new Date().toISOString() : null
  };
  const h = await db.collection('historial').findOneAndUpdate({ _id: oid }, { $set: cambios }, { arrayFilters: [{ 'g.userId': String(userId) }], returnDocument: 'after' });
  if (!h) return res.json({ error: 'Registro no encontrado' });
  await db.collection('sorteos').updateOne({ _id: h.sorteoId }, { $set: cambios }, { arrayFilters: [{ 'g.userId': String(userId) }] });
  if (pagado && notificar !== false) {
    const g = (h.ganadores || []).find(x => x.userId === String(userId));
    if (g) await avisar(userId, `💸 *¡Tu premio fue enviado!*\n\n💵 *$${L.fmtUsd(L.usdDe(g.premio))} USD*${txid ? `\n🧾 Referencia: \`${String(txid).replace(/[`]/g, '')}\`` : ''}\n\n¡Gracias por jugar en Lucky Stars! ⭐`);
  }
  res.json({ ok: true });
}));

app.post('/admin/crear-sorteo', admin(async (req, res) => {
  if (await getSorteoActivo()) return res.json({ error: 'Ya hay un sorteo activo. Ciérralo primero.' });
  const { titulo, metaBoletos, premios, fechaSorteo } = req.body;
  const meta = parseInt(metaBoletos, 10);
  if (!meta || meta < 2 || meta > 50000) return res.json({ error: 'La meta de boletos debe estar entre 2 y 50000' });
  const p = L.parsePremiosEntrada(premios);
  if (p.error) return res.json({ error: p.error });
  const f = fechaFutura(fechaSorteo);
  if (f.error) return res.json({ error: f.error });
  if (f.valor && new Date(f.valor) <= new Date()) return res.json({ error: 'La fecha del sorteo debe estar en el futuro' });
  const sorteo = {
    titulo: String(titulo || '').trim().slice(0, 80) || 'Nuevo Sorteo Lucky Stars', activo: true, metaBoletos: meta, premios: p.premios,
    fechaSorteo: f.valor, boletos: [], contador: 0, ganadores: [], fechaCreacion: new Date().toISOString(), fechaFin: null
  };
  await db.collection('sorteos').insertOne(sorteo);
  res.json({ ok: true });
}));

app.post('/admin/editar-sorteo', admin(async (req, res) => {
  const sorteo = await getSorteoActivo();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  const { titulo, metaBoletos, premios, fechaSorteo } = req.body;
  const set = {};
  if (titulo !== undefined) {
    const t = String(titulo).trim().slice(0, 80);
    if (t) set.titulo = t;
  }
  if (metaBoletos !== undefined) {
    const meta = parseInt(metaBoletos, 10);
    if (!meta || meta < 2 || meta > 50000) return res.json({ error: 'La meta de boletos debe estar entre 2 y 50000' });
    if (meta < sorteo.boletos.length) return res.json({ error: `Ya hay ${sorteo.boletos.length} boletos repartidos; la meta no puede ser menor` });
    set.metaBoletos = meta;
  }
  if (premios !== undefined) {
    const p = L.parsePremiosEntrada(premios);
    if (p.error) return res.json({ error: p.error });
    set.premios = p.premios;
  }
  if (fechaSorteo !== undefined) {
    const f = fechaFutura(fechaSorteo);
    if (f.error) return res.json({ error: f.error });
    if (f.valor && new Date(f.valor) <= new Date()) return res.json({ error: 'La fecha del sorteo debe estar en el futuro' });
    set.fechaSorteo = f.valor;
  }
  if (Object.keys(set).length) await db.collection('sorteos').updateOne({ _id: sorteo._id }, { $set: set });
  res.json({ ok: true });
}));

app.post('/admin/cerrar-sorteo', admin(async (req, res) => {
  const sorteo = await getSorteoActivo();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  const r = await realizarSorteo(sorteo._id);
  res.json({ ok: !!r, ganadores: r ? r.ganadores.length : 0 });
}));

app.post('/admin/cancelar-sorteo', admin(async (req, res) => {
  const s = await db.collection('sorteos').findOneAndUpdate({ activo: true }, { $set: { activo: false, cancelado: true, fechaFin: new Date().toISOString() } }, { returnDocument: 'after' });
  if (!s) return res.json({ error: 'No hay sorteo activo' });
  await db.collection('historial').insertOne({ sorteoId: s._id, titulo: s.titulo, ganadores: [], cancelado: true, totalBoletos: s.boletos.length, participantes: new Set(s.boletos.map(b => b.userId)).size, fecha: new Date().toISOString() });
  res.json({ ok: true });
}));

app.post('/admin/dar-boletos', admin(async (req, res) => {
  const ref = String(req.body.usuario || '').trim().replace(/^@/, '');
  const cantidad = Math.min(50, Math.max(1, parseInt(req.body.cantidad, 10) || 1));
  if (!ref) return res.json({ error: 'Indica el usuario' });
  const u = await db.collection('usuarios').findOne({ $or: [{ userId: ref }, { username: new RegExp('^' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }] });
  if (!u) return res.json({ error: 'Usuario no encontrado (debe haber usado el bot antes)' });
  if (u.baneado) return res.json({ error: 'El usuario está suspendido' });
  const numeros = [];
  for (let i = 0; i < cantidad; i++) {
    const r = await darBoleto(u.userId, 'regalo', u);
    if (r.error) { if (!numeros.length) return res.json({ error: r.error }); break; }
    numeros.push(r.numero);
  }
  await avisar(u.userId, `🎁 *¡Recibiste ${numeros.length} boleto(s) de regalo!*\n\n${numeros.map(n => '#' + n).join('  ')}\n\n¡Buena suerte! ⭐`);
  res.json({ ok: true, entregados: numeros.length, usuario: u.username || u.userId });
}));

app.post('/admin/boleto-eliminar', admin(async (req, res) => {
  const r = await db.collection('sorteos').updateOne({ activo: true }, { $pull: { boletos: { numero: String(req.body.numero) } } });
  res.json({ ok: r.modifiedCount === 1, error: r.modifiedCount === 1 ? undefined : 'Boleto no encontrado' });
}));

app.post('/admin/banear', admin(async (req, res) => {
  const userId = String(req.body.userId || '');
  const ban = !!req.body.ban;
  const r = await db.collection('usuarios').updateOne({ userId }, { $set: { baneado: ban } });
  if (!r.matchedCount) return res.json({ error: 'Usuario no encontrado' });
  let retirados = 0;
  if (ban) {
    const s = await getSorteoActivo();
    if (s) {
      retirados = s.boletos.filter(b => b.userId === userId).length;
      await db.collection('sorteos').updateOne({ _id: s._id }, { $pull: { boletos: { userId } } });
    }
  }
  res.json({ ok: true, boletosRetirados: retirados });
}));

app.post('/admin/config', admin(async (req, res) => {
  const b = req.body;
  const set = {};
  const num = (v, min, max) => { const n = Number(v); return isFinite(n) && n >= min && n <= max ? n : null; };
  if (b.adLimitDiario !== undefined) { const n = num(b.adLimitDiario, 1, 50); if (n === null) return res.json({ error: 'Límite diario: entre 1 y 50' }); set.adLimitDiario = Math.floor(n); }
  if (b.cooldownSeg !== undefined) { const n = num(b.cooldownSeg, 0, 300); if (n === null) return res.json({ error: 'Espera entre anuncios: entre 0 y 300 segundos' }); set.cooldownSeg = Math.floor(n); }
  if (b.cpmUsd !== undefined) { const n = num(b.cpmUsd, 0, 200); if (n === null) return res.json({ error: 'CPM estimado: entre 0 y 200' }); set.cpmUsd = n; }
  if (b.avisoBienvenida !== undefined) set.avisoBienvenida = String(b.avisoBienvenida).trim().slice(0, 300);
  if (Object.keys(set).length) await db.collection('config').updateOne({ _id: 'main' }, { $set: set }, { upsert: true });
  res.json({ ok: true, config: await getConfig(true) });
}));

app.get('/', (req, res) => res.json({ status: 'Lucky Stars Backend activo ⭐' }));

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Puerto ${PORT}`));

  callTelegram('setMyCommands', {
    commands: [
      { command: 'start', description: 'Menú principal' },
      { command: 'sorteo', description: 'Estado del sorteo y premios' },
      { command: 'misboletos', description: 'Ver mis boletos' },
      { command: 'gratis', description: 'Boleto gratis por unirte al canal' },
      { command: 'referidos', description: 'Mi link para invitar amigos' },
      { command: 'wallet', description: 'Registrar mi wallet para cobrar premios' }
    ]
  }).catch(() => {});

  // Sorteo automático cuando llega la fecha programada
  setInterval(async () => {
    try {
      const s = await getSorteoActivo();
      if (s && s.fechaSorteo && new Date(s.fechaSorteo) <= new Date()) await realizarSorteo(s._id);
    } catch (e) { console.error('Error en sorteo programado:', e); }
  }, 60000);
}).catch(err => {
  console.error('Error conectando MongoDB:', err);
  process.exit(1);
});
