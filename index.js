const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CANAL_ID = process.env.CANAL_ID || '@LuckyStarsOficial';
const MONGODB_URI = process.env.MONGODB_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cultogore.github.io/luckystars-frontend/';
const PORT = process.env.PORT || 3000;

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('luckystars');
  console.log('MongoDB conectado');

  // Crear sorteo inicial si no existe
  const sorteoActivo = await db.collection('sorteos').findOne({ activo: true });
  if (!sorteoActivo) {
    await db.collection('sorteos').insertOne({
      titulo: 'Sorteo #1 — Lucky Stars',
      activo: true,
      precioPorBoleto: 50,
      metaBoletos: 100,
      premios: [
        { lugar: 1, descripcion: '1er Premio', monto: 2500, moneda: 'Stars' },
        { lugar: 2, descripcion: '2do Premio', monto: 1000, moneda: 'Stars' },
        { lugar: 3, descripcion: '3er Premio', monto: 500, moneda: 'Stars' }
      ],
      boletos: [],
      ganadores: [],
      fechaCreacion: new Date().toISOString(),
      fechaFin: null,
      totalRecaudado: 0
    });
    console.log('Sorteo inicial creado');
  }
}

function generarId() {
  return Math.random().toString(36).substr(2, 9);
}

async function getSorteoActivo() {
  return db.collection('sorteos').findOne({ activo: true });
}

async function getUsuario(userId) {
  let usuario = await db.collection('usuarios').findOne({ userId });
  if (!usuario) {
    usuario = {
      userId,
      username: '',
      firstName: '',
      referidoPor: null,
      referidosQueCompraron: 0,
      joinedCanal: false,
      totalComprado: 0,
      boletosGratisCanal: false,
      fechaRegistro: new Date().toISOString()
    };
    await db.collection('usuarios').insertOne(usuario);
  }
  return usuario;
}

async function callTelegram(method, data) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
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

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const update = req.body;

  if (update.pre_checkout_query) {
    await callTelegram('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
  }

    if (update.callback_query) {
    const cb = update.callback_query;
    await callTelegram('answerCallbackQuery', { callback_query_id: cb.id });
    if (cb.data && cb.data.startsWith('ref_')) {
      const userId = cb.data.replace('ref_', '');
      const link = `https://t.me/LuckyStarsOficial_bot?start=ref_${userId}`;
      await callTelegram('sendMessage', {
        chat_id: cb.message.chat.id,
        text: `👥 *Tu link de referidos:*\n\n\`${link}\`\n\nCompártelo con tus amigos. Cuando compren su primer boleto, ¡tú ganas 1 boleto gratis!\n\n🏆 5 referidos = 2 boletos extra\n🌟 10 referidos = 5 boletos extra`,
        parse_mode: 'Markdown'
      });
    }
  }

  if (update.message) {
  
  if (update.message) {
    const msg = update.message;
    const userId = String(msg.from.id);
    const usuario = await getUsuario(userId);

    await db.collection('usuarios').updateOne(
      { userId },
      { $set: { username: msg.from.username || '', firstName: msg.from.first_name || '' } }
    );

    if (msg.successful_payment) await procesarPago(msg);

    if (msg.text) {
      if (msg.text.startsWith('/start')) {
        const params = msg.text.split(' ')[1];
        if (params && params.startsWith('ref_')) {
          const referidorId = params.replace('ref_', '');
          if (referidorId !== userId && !usuario.referidoPor) {
            await db.collection('usuarios').updateOne({ userId }, { $set: { referidoPor: referidorId } });
          }
        }
        await enviarBienvenida(msg.chat.id, userId);
      }
      if (msg.text === '/sorteo') await enviarEstadoSorteo(msg.chat.id);
      if (msg.text === '/misboletos') await enviarMisBoletosMsg(msg.chat.id, userId);
      if (msg.text === '/referidos') await enviarInfoReferidos(msg.chat.id, userId);
      if (msg.text === '/gratis') await procesarBoletosGratis(msg.chat.id, userId);
    }
  }

  res.sendStatus(200);
});

async function enviarBienvenida(chatId, userId) {
  const sorteo = await getSorteoActivo();
  const vendidos = sorteo ? sorteo.boletos.filter(b => b.pagado).length : 0;

  let text = `⭐ *Bienvenido a Lucky Stars*\n\nEl sorteo de Telegram más emocionante.\n\n`;
  if (sorteo) {
    text += `🎯 *Sorteo activo:* ${sorteo.titulo}\n`;
    text += `🎟 *Precio:* *$1 USD* (${sorteo.precioPorBoleto} ⭐) por boleto\n`;
    text += `📊 *Vendidos:* ${vendidos}/${sorteo.metaBoletos}\n\n`;
    text += `🏆 *Premios:*\n`;
    sorteo.premios.forEach(p => {
      const usd = (p.monto / 50).toFixed(0);
      text += `${p.lugar === 1 ? '🥇' : p.lugar === 2 ? '🥈' : '🥉'} ${p.descripcion}: *$${usd} USD* (${p.monto} ⭐)\n`;
    });
  }
  text += `\n🎁 *Boleto gratis:* Únete a @LuckyStarsOficial y escribe /gratis\n`;
  text += `👥 *Referidos:* Invita amigos y gana boletos extra\n\n`;
  text += `Usa el botón de abajo para participar 👇`;

  await enviarMensaje(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎟 Comprar Boletos', web_app: { url: FRONTEND_URL } }],
        [{ text: '⭐ Canal Oficial', url: 'https://t.me/LuckyStarsOficial' }],
        [{ text: '👥 Invitar Amigos', callback_data: 'ref_' + userId }]
      ]
    }
  });
}

async function procesarBoletosGratis(chatId, userId) {
  const sorteo = await getSorteoActivo();
  const usuario = await getUsuario(userId);

  if (!sorteo || !sorteo.activo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  if (usuario.boletosGratisCanal) { await enviarMensaje(chatId, '⚠️ Ya reclamaste tu boleto gratis por unirte al canal.'); return; }

  const esMiembro = await verificarMembresia(userId);
  if (!esMiembro) {
    await enviarMensaje(chatId, `❌ No eres miembro de @LuckyStarsOficial.\n\nÚnete primero y luego escribe /gratis.`, {
      reply_markup: { inline_keyboard: [[{ text: '⭐ Unirse al Canal', url: 'https://t.me/LuckyStarsOficial' }]] }
    });
    return;
  }

  const numero = String(sorteo.boletos.length + 1).padStart(3, '0');
  const boleto = { numero, userId, username: usuario.username || usuario.firstName, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'canal' };

  await db.collection('sorteos').updateOne({ activo: true }, { $push: { boletos: boleto } });
  await db.collection('usuarios').updateOne({ userId }, { $set: { boletosGratisCanal: true, joinedCanal: true } });

  await enviarMensaje(chatId, `✅ *¡Boleto gratis reclamado!*\n\nTu boleto #${numero} está en el sorteo.\n\n¡Buena suerte! ⭐`);
}

async function procesarPago(msg) {
  const payment = msg.successful_payment;
  const userId = String(msg.from.id);
  const usuario = await getUsuario(userId);
  const partes = payment.invoice_payload.split('_');
  const cantidad = parseInt(partes[1]);
  const sorteoId = partes[2];

  const sorteo = await db.collection('sorteos').findOne({ _id: require('mongodb').ObjectId ? undefined : sorteoId, activo: true });
  if (!sorteo) { await enviarMensaje(msg.chat.id, '❌ El sorteo ya terminó.'); return; }

  const nuevosNumeros = [];
  const nuevosBoletos = [];

  for (let i = 0; i < cantidad; i++) {
    const numero = String(sorteo.boletos.length + nuevosBoletos.length + 1).padStart(3, '0');
    nuevosBoletos.push({ numero, userId, username: usuario.username || usuario.firstName, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: false, pagado: true });
    nuevosNumeros.push(numero);
  }

  await db.collection('sorteos').updateOne(
    { activo: true },
    { $push: { boletos: { $each: nuevosBoletos } }, $inc: { totalRecaudado: payment.total_amount } }
  );
  await db.collection('usuarios').updateOne({ userId }, { $inc: { totalComprado: cantidad } });

  // Procesar referido
  const usuarioActualizado = await getUsuario(userId);
  if (usuario.referidoPor && usuarioActualizado.totalComprado === cantidad) {
    const referidor = await getUsuario(usuario.referidoPor);
    await db.collection('usuarios').updateOne({ userId: usuario.referidoPor }, { $inc: { referidosQueCompraron: 1 } });

    const numBoleto = String(sorteo.boletos.length + nuevosBoletos.length + 1).padStart(3, '0');
    await db.collection('sorteos').updateOne(
      { activo: true },
      { $push: { boletos: { numero: numBoleto, userId: usuario.referidoPor, username: referidor.username || referidor.firstName, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'referido' } } }
    );

    try { await enviarMensaje(usuario.referidoPor, `🎉 *¡Boleto gratis ganado!*\n\nTu referido @${usuario.username || usuario.firstName} compró su primer boleto.\n\n🎟 Te dimos el boleto #${numBoleto} gratis. ¡Buena suerte!`); } catch (e) {}

    const referidorActualizado = await getUsuario(usuario.referidoPor);
    if (referidorActualizado.referidosQueCompraron === 5) {
      for (let i = 0; i < 2; i++) {
        const n = String((await getSorteoActivo()).boletos.length + 1).padStart(3, '0');
        await db.collection('sorteos').updateOne({ activo: true }, { $push: { boletos: { numero: n, userId: usuario.referidoPor, username: referidor.username, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'bonus5' } } });
      }
      try { await enviarMensaje(usuario.referidoPor, `🏆 *¡BONUS!* 5 referidos = *2 boletos extra* 🎟`); } catch (e) {}
    }

    if (referidorActualizado.referidosQueCompraron === 10) {
      for (let i = 0; i < 5; i++) {
        const n = String((await getSorteoActivo()).boletos.length + 1).padStart(3, '0');
        await db.collection('sorteos').updateOne({ activo: true }, { $push: { boletos: { numero: n, userId: usuario.referidoPor, username: referidor.username, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'bonus10' } } });
      }
      try { await enviarMensaje(usuario.referidoPor, `🌟 *¡MEGA BONUS!* 10 referidos = *5 boletos extra* 🎟`); } catch (e) {}
    }
  }

  await enviarMensaje(msg.chat.id, `✅ *¡Compra exitosa!*\n\nTus boletos: ${nuevosNumeros.map(n => '#' + n).join(', ')}\n\n¡Buena suerte! ⭐`);

  const sorteoFinal = await getSorteoActivo();
  if (sorteoFinal && sorteoFinal.boletos.filter(b => b.pagado).length >= sorteoFinal.metaBoletos) {
    await realizarSorteo(sorteoFinal);
  }
}

async function realizarSorteo(sorteo) {
  await db.collection('sorteos').updateOne({ activo: true }, { $set: { activo: false, fechaFin: new Date().toISOString() } });

  const boletosValidos = sorteo.boletos.filter(b => b.pagado);
  const ganadores = [];
  const usersGanadores = new Set();

  for (let i = 0; i < Math.min(sorteo.premios.length, boletosValidos.length); i++) {
    let boleto;
    do { boleto = boletosValidos[Math.floor(Math.random() * boletosValidos.length)]; }
    while (usersGanadores.has(boleto.userId));
    usersGanadores.add(boleto.userId);
    const premio = sorteo.premios[i];
    ganadores.push({ ...boleto, premio });
    try {
      await enviarMensaje(boleto.userId, `🏆 *¡FELICIDADES! ¡GANASTE!*\n\n${['🥇','🥈','🥉'][i]} ${premio.descripcion}\n💰 *$${(premio.monto/50).toFixed(0)} USD* (${premio.monto} ⭐)\n🎟 Boleto: #${boleto.numero}\n\nContacta al administrador para reclamar.`);
    } catch (e) {}
  }

  await db.collection('sorteos').updateOne({ activo: false, fechaFin: { $exists: true } }, { $set: { ganadores } });
  await db.collection('historial').insertOne({ sorteoId: sorteo._id, titulo: sorteo.titulo, ganadores, fecha: new Date().toISOString() });
}

async function enviarEstadoSorteo(chatId) {
  const sorteo = await getSorteoActivo();
  if (!sorteo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  const vendidos = sorteo.boletos.filter(b => b.pagado).length;
  await enviarMensaje(chatId, `📊 *${sorteo.titulo}*\n\n🎟 Vendidos: ${vendidos}/${sorteo.metaBoletos}\n⏳ Restantes: ${sorteo.metaBoletos - vendidos}\n💰 Precio: *$1 USD* (${sorteo.precioPorBoleto} ⭐)\n\n🏆 *Premios:*\n${sorteo.premios.map((p,i) => `${['🥇','🥈','🥉'][i]} ${p.descripcion}: *$${(p.monto/50).toFixed(0)} USD* (${p.monto} ⭐)`).join('\n')}`);
}

async function enviarMisBoletosMsg(chatId, userId) {
  const sorteo = await getSorteoActivo();
  if (!sorteo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  const misB = sorteo.boletos.filter(b => b.userId === userId && b.pagado);
  if (misB.length === 0) { await enviarMensaje(chatId, '❌ No tienes boletos en este sorteo.'); return; }
  await enviarMensaje(chatId, `🎟 *Tus boletos:*\n\n${misB.map(b => `#${b.numero}${b.esBoletoGratis ? ' *(gratis)*' : ''}`).join('\n')}\n\nTotal: ${misB.length} boleto(s). ¡Buena suerte! ⭐`);
}

async function enviarInfoReferidos(chatId, userId) {
  const usuario = await getUsuario(userId);
  const link = `https://t.me/LuckyStarsOficial_bot?start=ref_${userId}`;
  await enviarMensaje(chatId, `👥 *Tu sistema de referidos*\n\n🔗 *Tu link:*\n\`${link}\`\n\n✅ Referidos que compraron: *${usuario.referidosQueCompraron}*\n\n🎁 *Recompensas:*\n• Cada referido que compre = 1 boleto gratis\n• 5 referidos = 2 boletos extra\n• 10 referidos = 5 boletos extra\n\n¡Comparte y gana!`);
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────
app.get('/api/sorteo', async (req, res) => {
  const sorteo = await getSorteoActivo();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  const vendidos = sorteo.boletos.filter(b => b.pagado).length;
  res.json({ id: sorteo._id, titulo: sorteo.titulo, activo: sorteo.activo, precioPorBoleto: sorteo.precioPorBoleto, metaBoletos: sorteo.metaBoletos, vendidos, restantes: sorteo.metaBoletos - vendidos, premios: sorteo.premios, porcentaje: Math.round((vendidos / sorteo.metaBoletos) * 100) });
});

app.get('/api/mis-boletos/:userId', async (req, res) => {
  const sorteo = await getSorteoActivo();
  if (!sorteo) return res.json([]);
  res.json(sorteo.boletos.filter(b => b.userId === req.params.userId && b.pagado));
});

app.get('/api/usuario/:userId', async (req, res) => {
  const usuario = await getUsuario(req.params.userId);
  const link = `https://t.me/LuckyStarsOficial_bot?start=ref_${req.params.userId}`;
  res.json({ ...usuario, linkReferido: link });
});

app.post('/api/crear-invoice', async (req, res) => {
  const { userId, cantidad } = req.body;
  const sorteo = await getSorteoActivo();
  if (!sorteo || !sorteo.activo) return res.json({ error: 'No hay sorteo activo' });
  const totalStars = cantidad * sorteo.precioPorBoleto;
  const result = await callTelegram('createInvoiceLink', {
    title: sorteo.titulo,
    description: `${cantidad} boleto(s) — Premio: $${(sorteo.premios[0].monto/50).toFixed(0)} USD`,
    payload: `boleto_${cantidad}_${sorteo._id}`,
    currency: 'XTR',
    prices: [{ label: `${cantidad} boleto(s)`, amount: totalStars }]
  });
  if (result.ok) res.json({ invoiceUrl: result.result });
  else res.json({ error: result.description });
});

app.post('/api/reclamar-gratis', async (req, res) => {
  const { userId } = req.body;
  const sorteo = await getSorteoActivo();
  const usuario = await getUsuario(userId);
  if (!sorteo || !sorteo.activo) return res.json({ error: 'No hay sorteo activo' });
  if (usuario.boletosGratisCanal) return res.json({ error: 'Ya reclamaste tu boleto gratis' });
  const esMiembro = await verificarMembresia(userId);
  if (!esMiembro) return res.json({ error: 'Únete a @LuckyStarsOficial primero' });
  const numero = String(sorteo.boletos.length + 1).padStart(3, '0');
  await db.collection('sorteos').updateOne({ activo: true }, { $push: { boletos: { numero, userId, username: usuario.username, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'canal' } } });
  await db.collection('usuarios').updateOne({ userId }, { $set: { boletosGratisCanal: true, joinedCanal: true } });
  res.json({ ok: true, numero });
});

// ─── ADMIN API ────────────────────────────────────────────────────────────────
function verificarAdmin(req, res) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) { res.status(401).json({ error: 'No autorizado' }); return false; }
  return true;
}

app.get('/admin/stats', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const sorteo = await getSorteoActivo();
  const totalUsuarios = await db.collection('usuarios').countDocuments();
  const historialCount = await db.collection('historial').countDocuments();
  res.json({
    sorteoActivo: sorteo ? { id: sorteo._id, titulo: sorteo.titulo, vendidos: sorteo.boletos.filter(b => b.pagado).length, metaBoletos: sorteo.metaBoletos, totalRecaudado: sorteo.totalRecaudado, premios: sorteo.premios } : null,
    totalUsuarios, historialSorteos: historialCount,
    boletos: sorteo ? sorteo.boletos : []
  });
});

app.post('/admin/crear-sorteo', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const sorteoActivo = await getSorteoActivo();
  if (sorteoActivo) return res.json({ error: 'Ya hay un sorteo activo. Ciérralo primero.' });
  const { titulo, precioPorBoleto, metaBoletos, premios } = req.body;
  const sorteo = { titulo: titulo || 'Nuevo Sorteo Lucky Stars', activo: true, precioPorBoleto: precioPorBoleto || 50, metaBoletos: metaBoletos || 100, premios: premios || [{ lugar: 1, descripcion: '1er Premio', monto: 2500, moneda: 'Stars' }, { lugar: 2, descripcion: '2do Premio', monto: 1000, moneda: 'Stars' }, { lugar: 3, descripcion: '3er Premio', monto: 500, moneda: 'Stars' }], boletos: [], ganadores: [], fechaCreacion: new Date().toISOString(), fechaFin: null, totalRecaudado: 0 };
  await db.collection('sorteos').insertOne(sorteo);
  res.json({ ok: true, sorteo });
});

app.post('/admin/editar-sorteo', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { titulo, precioPorBoleto, metaBoletos, premios } = req.body;
  const update = {};
  if (titulo) update.titulo = titulo;
  if (precioPorBoleto) update.precioPorBoleto = precioPorBoleto;
  if (metaBoletos) update.metaBoletos = metaBoletos;
  if (premios) update.premios = premios;
  await db.collection('sorteos').updateOne({ activo: true }, { $set: update });
  res.json({ ok: true });
});

app.post('/admin/cerrar-sorteo', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const sorteo = await getSorteoActivo();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  await realizarSorteo(sorteo);
  res.json({ ok: true, ganadores: sorteo.ganadores });
});

app.get('/', (req, res) => res.json({ status: 'Lucky Stars Backend activo ⭐' }));

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Puerto ${PORT}`));
}).catch(err => {
  console.error('Error conectando MongoDB:', err);
  process.exit(1);
});
