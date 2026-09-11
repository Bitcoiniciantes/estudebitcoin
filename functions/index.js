/* Carteira — Cloud Functions (Fase 2).
 * Único caminho de escrita em users/{uid}/assets e lots.
 * Spec: fase2-ativos-firebase-persistencia-revisado.md (canônico).
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const { normalizarTicker } = require('./carteira/normalizacao');
const { validarEntradaAporte } = require('./carteira/validacao');
const { consolidarPosicao, reconstruirPosicaoDosLotes } = require('./carteira/calculos');

const LIMITE_MIGRACAO_ATIVOS = 200;
const LIMITE_EXCLUSAO_LOTES = 400;

function exigirAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  }
  return context.auth.uid;
}

function TS() {
  return admin.firestore.FieldValue.serverTimestamp();
}

/* ---------- adicionarOuConsolidarAtivo (§11) ---------- */
exports.adicionarOuConsolidarAtivo = functions.https.onCall(async (data, context) => {
  const uid = exigirAuth(context);

  const validacao = validarEntradaAporte(data);
  if (validacao.erros.length > 0) {
    throw new functions.https.HttpsError('invalid-argument', validacao.erros.join('; '));
  }

  const { ticker, type, dailyChangePercent } = validacao;
  const { name, quantity, purchasePrice, currentPrice } = data;
  const db = admin.firestore();
  const assetRef = db.collection('users').doc(uid).collection('assets').doc(ticker);

  const resultado = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(assetRef);
    const lotRef = assetRef.collection('lots').doc();
    let novoEstado;

    if (!snapshot.exists) {
      if (quantity < 0) {
        throw new functions.https.HttpsError(
          'failed-precondition', 'Não é possível vender um ativo inexistente.');
      }
      novoEstado = {
        ticker, name: name.trim(), type, quantity,
        avgPrice: purchasePrice, manualPrice: currentPrice, currentPrice,
        priceSource: 'manual', dailyChangePercent,
        createdAt: TS(), updatedAt: TS(),
      };
      tx.set(assetRef, novoEstado);
      tx.set(lotRef, { quantity, price: purchasePrice, date: TS() });
      return { ...novoEstado, action: 'created' };
    }

    let consolidado;
    try {
      consolidado = consolidarPosicao(snapshot.data(),
        { quantity, purchasePrice, currentPrice, dailyChangePercent });
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err.message);
    }

    if (consolidado.quantity === 0) {
      tx.update(assetRef, {
        quantity: 0, avgPrice: 0, currentPrice, manualPrice: currentPrice,
        dailyChangePercent, closedAt: TS(), updatedAt: TS(),
      });
      tx.set(lotRef, {
        quantity, price: purchasePrice,
        avgPrice: snapshot.data().avgPrice, date: TS(),
      });
      return { action: 'closed', quantity: 0 };
    }

    novoEstado = {
      ...consolidado, name: name.trim(), type,
      closedAt: admin.firestore.FieldValue.delete(), updatedAt: TS(),
    };
    tx.update(assetRef, novoEstado);

    const lote = { quantity, price: purchasePrice, date: TS() };
    if (quantity < 0) lote.avgPrice = snapshot.data().avgPrice;
    tx.set(lotRef, lote);

    return { ...novoEstado, action: quantity < 0 ? 'sold' : 'updated' };
  });

  if (resultado.action === 'closed') {
    return { status: 'ok', ticker, action: 'closed', quantity: 0 };
  }
  return {
    status: 'ok', ticker, action: resultado.action,
    quantity: resultado.quantity, avgPrice: resultado.avgPrice,
  };
});

/* ---------- atualizarAtivo (§12) ---------- */
exports.atualizarAtivo = functions.https.onCall(async (data, context) => {
  const uid = exigirAuth(context);
  const ticker = normalizarTicker(data && data.ticker);
  const { normalizarTipo } = require('./carteira/normalizacao');
  const type = normalizarTipo(data && data.type);

  if (!ticker) throw new functions.https.HttpsError('invalid-argument', 'ticker inválido.');
  if (typeof (data && data.name) !== 'string' || data.name.trim().length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'name inválido.');
  }
  if (!type) throw new functions.https.HttpsError('invalid-argument', 'type inválido.');

  const currentPrice = Number(data.currentPrice);
  const manualPrice = Number(data.manualPrice);
  const dailyChangePercent = data.dailyChangePercent == null
    ? 0 : Number(data.dailyChangePercent);

  if (!Number.isFinite(currentPrice) || currentPrice < 0) {
    throw new functions.https.HttpsError('invalid-argument', 'currentPrice inválido.');
  }
  if (!Number.isFinite(manualPrice) || manualPrice < 0) {
    throw new functions.https.HttpsError('invalid-argument', 'manualPrice inválido.');
  }
  if (!Number.isFinite(dailyChangePercent)) {
    throw new functions.https.HttpsError('invalid-argument', 'dailyChangePercent inválido.');
  }
  // Fase 2 usa somente preço manual. "api" reservado à Fase 3.
  if (data.priceSource !== 'manual') {
    throw new functions.https.HttpsError(
      'invalid-argument', 'priceSource inválido: na Fase 2 use apenas manual.');
  }

  const assetRef = admin.firestore()
    .collection('users').doc(uid).collection('assets').doc(ticker);
  const snapshot = await assetRef.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'Ativo não encontrado.');
  }

  // Last-writer-wins consciente: só cadastro/cotação, nunca quantity/avgPrice/lots.
  await assetRef.update({
    name: data.name.trim(), type, manualPrice, currentPrice,
    priceSource: 'manual', dailyChangePercent, updatedAt: TS(),
  });
  return { status: 'ok', ticker };
});

/* ---------- removerLote (§13) ---------- */
exports.removerLote = functions.https.onCall(async (data, context) => {
  const uid = exigirAuth(context);
  const ticker = normalizarTicker(data && data.ticker);
  const lotId = typeof (data && data.lotId) === 'string' ? data.lotId.trim() : '';
  if (!ticker || !lotId) {
    throw new functions.https.HttpsError(
      'invalid-argument', 'ticker e lotId são obrigatórios.');
  }

  const db = admin.firestore();
  const assetRef = db.collection('users').doc(uid).collection('assets').doc(ticker);

  await db.runTransaction(async (tx) => {
    const assetSnap = await tx.get(assetRef);
    if (!assetSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Ativo não encontrado.');
    }
    const lotsSnap = await tx.get(assetRef.collection('lots'));
    const lotRef = assetRef.collection('lots').doc(lotId);
    if (!lotsSnap.docs.some((doc) => doc.id === lotId)) {
      throw new functions.https.HttpsError('not-found', 'Lote não encontrado.');
    }
    const restantes = lotsSnap.docs
      .filter((doc) => doc.id !== lotId)
      .map((doc) => doc.data());

    let reconstruida;
    try {
      reconstruida = reconstruirPosicaoDosLotes(restantes);
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err.message);
    }

    tx.delete(lotRef);
    tx.update(assetRef, {
      quantity: reconstruida.quantity,
      avgPrice: reconstruida.avgPrice,
      ...(reconstruida.closed
        ? { closedAt: TS() }
        : { closedAt: admin.firestore.FieldValue.delete() }),
      updatedAt: TS(),
    });
  });

  return { status: 'ok', ticker, lotId };
});

/* ---------- removerAtivo (§14) ---------- */
exports.removerAtivo = functions.https.onCall(async (data, context) => {
  const uid = exigirAuth(context);
  const ticker = normalizarTicker(data && data.ticker);
  if (!ticker) {
    throw new functions.https.HttpsError('invalid-argument', 'ticker inválido.');
  }

  const db = admin.firestore();
  const assetRef = db.collection('users').doc(uid).collection('assets').doc(ticker);

  await db.runTransaction(async (tx) => {
    const assetSnap = await tx.get(assetRef);
    if (!assetSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Ativo não encontrado.');
    }
    const lotsSnap = await tx.get(assetRef.collection('lots'));
    if (lotsSnap.size > LIMITE_EXCLUSAO_LOTES) {
      throw new functions.https.HttpsError(
        'out-of-range', 'Ativo com lotes demais para exclusão atômica.');
    }
    lotsSnap.docs.forEach((lot) => { tx.delete(lot.ref); });
    tx.delete(assetRef);
  });

  return { status: 'ok', ticker };
});

/* ---------- migrarCarteiraLocal (§16) ---------- */
exports.migrarCarteiraLocal = functions.https.onCall(async (data, context) => {
  const uid = exigirAuth(context);

  if (!Array.isArray(data && data.itens)) {
    throw new functions.https.HttpsError('invalid-argument', 'itens deve ser um array.');
  }

  const itensValidados = data.itens.map((item) => {
    const validacao = validarEntradaAporte(item);
    if (validacao.erros.length > 0) {
      throw new functions.https.HttpsError(
        'invalid-argument', `Item "${item.ticker}": ${validacao.erros.join('; ')}`);
    }
    // Migração importa posições consolidadas (Fase 1), não movimentos.
    if (typeof item.quantity !== 'number' ||
        !Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `Item "${item.ticker}": quantity deve ser maior que zero na migração.`);
    }
    return {
      ...item,
      ticker: validacao.ticker,
      type: validacao.type,
      dailyChangePercent: validacao.dailyChangePercent,
    };
  });

  // 200 ativos ≈ 401 writes (200 assets + 200 lots + 1 user). Margem até 500.
  if (itensValidados.length > LIMITE_MIGRACAO_ATIVOS) {
    throw new functions.https.HttpsError(
      'out-of-range', 'A migração permite no máximo 200 ativos por operação.');
  }

  const tickers = new Set();
  for (const item of itensValidados) {
    if (tickers.has(item.ticker)) {
      throw new functions.https.HttpsError(
        'invalid-argument', `Ticker duplicado na migração: ${item.ticker}`);
    }
    tickers.add(item.ticker);
  }

  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);

  return await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (userSnap.exists && userSnap.data().localMigrationCompleted === true) {
      return { status: 'already_migrated' };
    }

    const assetRefs = itensValidados.map((item) =>
      userRef.collection('assets').doc(item.ticker));
    const assetSnaps = await tx.getAll(...assetRefs);
    if (assetSnaps.some((snap) => snap.exists)) {
      return { status: 'remote_exists' };
    }

    itensValidados.forEach((item, index) => {
      const assetRef = assetRefs[index];
      // ID determinístico: reescrita idempotente em migração simultânea.
      const lotRef = assetRef.collection('lots').doc('mig_' + item.ticker);
      tx.set(assetRef, {
        ticker: item.ticker, name: item.name.trim(), type: item.type,
        quantity: item.quantity, avgPrice: item.purchasePrice,
        manualPrice: item.currentPrice, currentPrice: item.currentPrice,
        priceSource: 'manual', dailyChangePercent: item.dailyChangePercent,
        createdAt: TS(), updatedAt: TS(),
      });
      tx.set(lotRef, {
        quantity: item.quantity, price: item.purchasePrice, date: TS(),
      });
    });

    const currency = typeof (data && data.currency) === 'string' &&
      data.currency.trim().length > 0
      ? data.currency.trim().slice(0, 8)
      : (userSnap.exists && userSnap.data().currency
        ? userSnap.data().currency : 'USD');

    tx.set(userRef, {
      currency, localMigrationCompleted: true, localMigrationAt: TS(),
    }, { merge: true });

    return { status: 'migrated', itens: itensValidados.length };
  });
});
