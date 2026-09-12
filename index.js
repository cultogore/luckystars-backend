const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CANAL_ID = process.env.CANAL_ID || '@LuckyStarsOficial';
const PORT = process.env.PORT || 3000;

// ─── BASE DE DATOS EN MEMORIA ───────────────────────────────────────────────
let db = {
  sorteos: [],
  usuarios: {}, // userId -> { username, firstName, boletos, referidoPor, referidos, joinedCanal, totalComprado }
  sorteoActualId: null,
  historial: []
};

// Crear sorteo inicial de ejemplo
function crearSorteoInicial() {
  const sorteo = {
    id: generarId(),
    titulo: 'Sorteo #1 — Lucky Stars',
    activo: true,
    precioPorBoleto: 50, // Stars (50 Stars = $1 USD)
    metaBoletos: 100,
    premios: [
      { lugar: 1, descripcion: '1er Premio', monto: 2500, moneda: 'Stars' },
      { lugar: 2, descripcion: '2do Premio', monto: 1000, moneda: 'Stars' },
      { lugar: 3, descripcion: '3er Premio', monto: 500, moneda: 'Stars' }
    ],
    boletos: [], // { numero, userId, username, fecha, esBoletoGratis }
    ganadores: [],
    fechaCreacion: new Date().toISOString(),
    fechaFin: null,
    totalRecaudado: 0
  };
  db.sorteos.push(sorteo);
  db.sorteoActualId = sorteo.id;
  return sorteo;
}

function generarId() {
  return Math.random().toString(36).substr(2, 9);
}

function getSorteoActual() {
  return db.sorteos.find(s => s.id === db.sorteoActualId);
}

function getSorteoById(id) {
  return db.sorteos.find(s => s.id === id);
}

function getUsuario(userId) {
  if (!db.usuarios[userId]) {
    db.usuarios[userId] = {
      userId,
      username: '',
      firstName: '',
      boletos: 0,
      referidoPor: null,
      referidos: [],
      referidosQueCompraron: 0,
      joinedCanal: false,
      totalComprado: 0,
      boletosGratisCanal: false,
      fechaRegistro: new Date().toISOString()
    };
  }
  return db.usuarios[userId];
}

// ─── TELEGRAM API ────────────────────────────────────────────────────────────
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
    const res = await callTelegram('getChatMember', {
      chat_id: CANAL_ID,
      user_id: userId
    });
    if (res.ok) {
      const status = res.result.status;
      return ['member', 'administrator', 'creator'].includes(status);
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function enviarMensaje(chatId, text, extra = {}) {
  return callTelegram('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const update = req.body;

  if (update.pre_checkout_query) {
    await callTelegram('answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok: true
    });
  }

  if (update.message) {
    const msg = update.message;
    const userId = String(msg.from.id);
    const usuario = getUsuario(userId);
    usuario.username = msg.from.username || '';
    usuario.firstName = msg.from.first_name || '';

    if (msg.successful_payment) {
      await procesarPago(msg);
    }

    if (msg.text) {
      if (msg.text.startsWith('/start')) {
        const params = msg.text.split(' ')[1];
        if (params && params.startsWith('ref_')) {
          const referidorId = params.replace('ref_', '');
          if (referidorId !== userId && !usuario.referidoPor) {
            usuario.referidoPor = referidorId;
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
  const sorteo = getSorteoActual();
  const usuario = getUsuario(userId);
  const vendidos = sorteo ? sorteo.boletos.filter(b => !b.esBoletoGratis || b.pagado).length : 0;

  let text = `⭐ *Bienvenido a Lucky Stars*\n\n`;
  text += `El sorteo de Telegram más emocionante.\n\n`;

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
        [{ text: '🎟 Comprar Boletos', web_app: { url: process.env.FRONTEND_URL || 'https://luckystars-oficial.github.io/luckystars-frontend/' } }],
        [{ text: '⭐ Canal Oficial', url: 'https://t.me/LuckyStarsOficial' }],
        [{ text: '👥 Invitar Amigos', callback_data: 'referido_' + userId }]
      ]
    }
  });
}

async function procesarBoletosGratis(chatId, userId) {
  const usuario = getUsuario(userId);
  const sorteo = getSorteoActual();

  if (!sorteo || !sorteo.activo) {
    await enviarMensaje(chatId, '❌ No hay sorteo activo en este momento.');
    return;
  }

  if (usuario.boletosGratisCanal) {
    await enviarMensaje(chatId, '⚠️ Ya reclamaste tu boleto gratis por unirte al canal.');
    return;
  }

  const esMiembro = await verificarMembresia(userId);
  if (!esMiembro) {
    await enviarMensaje(chatId, `❌ No eres miembro de @LuckyStarsOficial.\n\nÚnete primero y luego escribe /gratis para reclamar tu boleto.`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⭐ Unirse al Canal', url: 'https://t.me/LuckyStarsOficial' }]]
      }
    });
    return;
  }

  // Dar boleto gratis
  sorteo.boletos.push({
    numero: String(sorteo.boletos.length + 1).padStart(3, '0'),
    userId,
    username: usuario.username || usuario.firstName,
    fecha: new Date().toLocaleDateString('es-MX'),
    esBoletoGratis: true,
    pagado: true,
    motivo: 'canal'
  });

  usuario.boletosGratisCanal = true;
  usuario.joinedCanal = true;

  await enviarMensaje(chatId, `✅ *¡Boleto gratis reclamado!*\n\nTu boleto #${String(sorteo.boletos.length).padStart(3, '0')} está en el sorteo.\n\n¡Buena suerte! ⭐`);
}

async function procesarPago(msg) {
  const payment = msg.successful_payment;
  const userId = String(msg.from.id);
  const usuario = getUsuario(userId);
  const payload = payment.invoice_payload;
  const partes = payload.split('_');
  const cantidad = parseInt(partes[1]);
  const sorteoId = partes[2];

  const sorteo = getSorteoById(sorteoId);
  if (!sorteo || !sorteo.activo) {
    await enviarMensaje(msg.chat.id, '❌ El sorteo ya terminó.');
    return;
  }

  const nuevosNumeros = [];
  for (let i = 0; i < cantidad; i++) {
    const numero = String(sorteo.boletos.length + 1).padStart(3, '0');
    sorteo.boletos.push({
      numero,
      userId,
      username: usuario.username || usuario.firstName,
      fecha: new Date().toLocaleDateString('es-MX'),
      esBoletoGratis: false,
      pagado: true
    });
    nuevosNumeros.push(numero);
  }

  sorteo.totalRecaudado += payment.total_amount;
  usuario.totalComprado += cantidad;

  // Procesar referido — si este usuario fue referido y acaba de comprar por primera vez
  if (usuario.referidoPor && usuario.totalComprado === cantidad) {
    const referidor = getUsuario(usuario.referidoPor);
    referidor.referidosQueCompraron += 1;

    // Dar boleto gratis al referidor
    const numBoleto = String(sorteo.boletos.length + 1).padStart(3, '0');
    sorteo.boletos.push({
      numero: numBoleto,
      userId: usuario.referidoPor,
      username: referidor.username || referidor.firstName,
      fecha: new Date().toLocaleDateString('es-MX'),
      esBoletoGratis: true,
      pagado: true,
      motivo: 'referido'
    });

    // Notificar al referidor
    try {
      await enviarMensaje(usuario.referidoPor,
        `🎉 *¡Boleto gratis ganado!*\n\nTu referido @${usuario.username || usuario.firstName} acaba de comprar su primer boleto.\n\n🎟 Te dimos el boleto #${numBoleto} gratis. ¡Buena suerte!`
      );
    } catch (e) {}

    // Bonus por 5 referidos
    if (referidor.referidosQueCompraron === 5) {
      for (let i = 0; i < 2; i++) {
        const n = String(sorteo.boletos.length + 1).padStart(3, '0');
        sorteo.boletos.push({ numero: n, userId: usuario.referidoPor, username: referidor.username, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'bonus5' });
      }
      await enviarMensaje(usuario.referidoPor, `🏆 *¡BONUS DESBLOQUEADO!*\n\n¡Lograste 5 referidos que compraron!\n\n🎟 Te regalamos *2 boletos extra*. ¡Sigue invitando!`);
    }

    // Bonus por 10 referidos
    if (referidor.referidosQueCompraron === 10) {
      for (let i = 0; i < 5; i++) {
        const n = String(sorteo.boletos.length + 1).padStart(3, '0');
        sorteo.boletos.push({ numero: n, userId: usuario.referidoPor, username: referidor.username, fecha: new Date().toLocaleDateString('es-MX'), esBoletoGratis: true, pagado: true, motivo: 'bonus10' });
      }
      await enviarMensaje(usuario.referidoPor, `🌟 *¡MEGA BONUS!*\n\n¡10 referidos que compraron!\n\n🎟 Te regalamos *5 boletos extra*. ¡Eres una leyenda!`);
    }
  }

  await enviarMensaje(msg.chat.id,
    `✅ *¡Compra exitosa!*\n\nTus boletos: ${nuevosNumeros.map(n => '#' + n).join(', ')}\n\n📊 ${sorteo.boletos.filter(b => b.pagado).length}/${sorteo.metaBoletos} boletos vendidos\n\n¡Buena suerte! ⭐`
  );

  if (sorteo.boletos.filter(b => b.pagado).length >= sorteo.metaBoletos) {
    await realizarSorteo(sorteo);
  }
}

async function realizarSorteo(sorteo) {
  sorteo.activo = false;
  sorteo.fechaFin = new Date().toISOString();

  const boletosValidos = sorteo.boletos.filter(b => b.pagado);
  const ganadores = [];

  for (let i = 0; i < Math.min(sorteo.premios.length, boletosValidos.length); i++) {
    let ganadorIdx;
    do {
      ganadorIdx = Math.floor(Math.random() * boletosValidos.length);
    } while (ganadores.find(g => g.userId === boletosValidos[ganadorIdx].userId));

    const boleto = boletosValidos[ganadorIdx];
    const premio = sorteo.premios[i];
    ganadores.push({ ...boleto, premio });

    try {
      await enviarMensaje(boleto.userId,
        `🏆 *¡FELICIDADES! ¡GANASTE!*\n\n${premio.lugar === 1 ? '🥇' : premio.lugar === 2 ? '🥈' : '🥉'} ${premio.descripcion}\n💰 Premio: *${premio.monto} ${premio.moneda}*\n🎟 Boleto ganador: #${boleto.numero}\n\nContacta al administrador para reclamar tu premio.`
      );
    } catch (e) {}
  }

  sorteo.ganadores = ganadores;
  db.historial.push({ sorteoId: sorteo.id, titulo: sorteo.titulo, ganadores, fecha: new Date().toISOString() });
  db.sorteoActualId = null;
}

async function enviarEstadoSorteo(chatId) {
  const sorteo = getSorteoActual();
  if (!sorteo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  const vendidos = sorteo.boletos.filter(b => b.pagado).length;
  await enviarMensaje(chatId,
    `📊 *${sorteo.titulo}*\n\n🎟 Vendidos: ${vendidos}/${sorteo.metaBoletos}\n⏳ Restantes: ${sorteo.metaBoletos - vendidos}\n💰 Precio: ${sorteo.precioPorBoleto} ⭐\n\n🏆 *Premios:*\n${sorteo.premios.map(p => `${p.lugar === 1 ? '🥇' : p.lugar === 2 ? '🥈' : '🥉'} ${p.descripcion}: ${p.monto} ⭐`).join('\n')}`
  );
}

async function enviarMisBoletosMsg(chatId, userId) {
  const sorteo = getSorteoActual();
  if (!sorteo) { await enviarMensaje(chatId, '❌ No hay sorteo activo.'); return; }
  const misB = sorteo.boletos.filter(b => b.userId === userId && b.pagado);
  if (misB.length === 0) { await enviarMensaje(chatId, '❌ No tienes boletos en este sorteo.'); return; }
  await enviarMensaje(chatId, `🎟 *Tus boletos:*\n\n${misB.map(b => `#${b.numero}${b.esBoletoGratis ? ' *(gratis)*' : ''}`).join('\n')}\n\nTotal: ${misB.length} boleto(s). ¡Buena suerte! ⭐`);
}

async function enviarInfoReferidos(chatId, userId) {
  const usuario = getUsuario(userId);
  const link = `https://t.me/LuckyStarsOficial_bot?start=ref_${userId}`;
  let text = `👥 *Tu sistema de referidos*\n\n`;
  text += `🔗 *Tu link:* \`${link}\`\n\n`;
  text += `✅ Referidos que compraron: *${usuario.referidosQueCompraron}*\n\n`;
  text += `🎁 *Recompensas:*\n`;
  text += `• Cada referido que compre = 1 boleto gratis\n`;
  text += `• 5 referidos = 2 boletos extra\n`;
  text += `• 10 referidos = 5 boletos extra\n\n`;
  text += `¡Comparte tu link y gana boletos gratis!`;
  await enviarMensaje(chatId, text);
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────
app.get('/api/sorteo', (req, res) => {
  const sorteo = getSorteoActual();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  const vendidos = sorteo.boletos.filter(b => b.pagado).length;
  res.json({
    id: sorteo.id,
    titulo: sorteo.titulo,
    activo: sorteo.activo,
    precioPorBoleto: sorteo.precioPorBoleto,
    metaBoletos: sorteo.metaBoletos,
    vendidos,
    restantes: sorteo.metaBoletos - vendidos,
    premios: sorteo.premios,
    porcentaje: Math.round((vendidos / sorteo.metaBoletos) * 100)
  });
});

app.get('/api/mis-boletos/:userId', (req, res) => {
  const sorteo = getSorteoActual();
  if (!sorteo) return res.json([]);
  const misB = sorteo.boletos.filter(b => b.userId === req.params.userId && b.pagado);
  res.json(misB);
});

app.get('/api/usuario/:userId', (req, res) => {
  const usuario = getUsuario(req.params.userId);
  const link = `https://t.me/LuckyStarsOficial_bot?start=ref_${req.params.userId}`;
  res.json({ ...usuario, linkReferido: link });
});

app.post('/api/crear-invoice', async (req, res) => {
  const { userId, cantidad } = req.body;
  const sorteo = getSorteoActual();
  if (!sorteo || !sorteo.activo) return res.json({ error: 'No hay sorteo activo' });

  const totalStars = cantidad * sorteo.precioPorBoleto;
  const result = await callTelegram('createInvoiceLink', {
    title: sorteo.titulo,
    description: `${cantidad} boleto(s) — Premio mayor: ${sorteo.premios[0].monto} ⭐`,
    payload: `boleto_${cantidad}_${sorteo.id}`,
    currency: 'XTR',
    prices: [{ label: `${cantidad} boleto(s)`, amount: totalStars }]
  });

  if (result.ok) res.json({ invoiceUrl: result.result });
  else res.json({ error: result.description });
});

// ─── ADMIN API ────────────────────────────────────────────────────────────────
function verificarAdmin(req, res) {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'No autorizado' });
    return false;
  }
  return true;
}

app.get('/admin/stats', (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const sorteo = getSorteoActual();
  const vendidos = sorteo ? sorteo.boletos.filter(b => b.pagado).length : 0;
  const totalUsuarios = Object.keys(db.usuarios).length;
  res.json({
    sorteoActivo: sorteo ? { id: sorteo.id, titulo: sorteo.titulo, vendidos, metaBoletos: sorteo.metaBoletos, totalRecaudado: sorteo.totalRecaudado, premios: sorteo.premios } : null,
    totalUsuarios,
    historialSorteos: db.historial.length,
    boletos: sorteo ? sorteo.boletos : []
  });
});

app.post('/admin/crear-sorteo', (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const { titulo, precioPorBoleto, metaBoletos, premios } = req.body;
  if (db.sorteoActualId) {
    const actual = getSorteoActual();
    if (actual && actual.activo) {
      return res.json({ error: 'Ya hay un sorteo activo. Ciérralo primero.' });
    }
  }
  const sorteo = {
    id: generarId(),
    titulo: titulo || 'Nuevo Sorteo Lucky Stars',
    activo: true,
    precioPorBoleto: precioPorBoleto || 50,
    metaBoletos: metaBoletos || 100,
    premios: premios || [
      { lugar: 1, descripcion: '1er Premio', monto: 2500, moneda: 'Stars' },
      { lugar: 2, descripcion: '2do Premio', monto: 1000, moneda: 'Stars' },
      { lugar: 3, descripcion: '3er Premio', monto: 500, moneda: 'Stars' }
    ],
    boletos: [],
    ganadores: [],
    fechaCreacion: new Date().toISOString(),
    fechaFin: null,
    totalRecaudado: 0
  };
  db.sorteos.push(sorteo);
  db.sorteoActualId = sorteo.id;
  res.json({ ok: true, sorteo });
});

app.post('/admin/cerrar-sorteo', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const sorteo = getSorteoActual();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  await realizarSorteo(sorteo);
  res.json({ ok: true, ganadores: sorteo.ganadores });
});

app.post('/admin/editar-sorteo', (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const sorteo = getSorteoActual();
  if (!sorteo) return res.json({ error: 'No hay sorteo activo' });
  const { titulo, precioPorBoleto, metaBoletos, premios } = req.body;
  if (titulo) sorteo.titulo = titulo;
  if (precioPorBoleto) sorteo.precioPorBoleto = precioPorBoleto;
  if (metaBoletos) sorteo.metaBoletos = metaBoletos;
  if (premios) sorteo.premios = premios;
  res.json({ ok: true, sorteo });
});

app.get('/', (req, res) => res.json({ status: 'Lucky Stars Backend activo ⭐' }));

// Iniciar
crearSorteoInicial();
app.listen(PORT, () => console.log(`Lucky Stars Backend corriendo en puerto ${PORT}`));
