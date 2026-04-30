// ============================================================
// Gerar-Laudo-Importador — backup.js
// Sistema de 4 slots de backup do banco do usuário, separado do
// histórico de importações.
//
// Slots por especialidade:
//   - "original": criado uma vez, imutável (rede de segurança final)
//   - "slot1", "slot2", "slot3": gerenciáveis (salvar/restaurar/apagar)
//
// Armazenamento: subcollection users/{uid}/backups
//   doc id = "<tipo>_<slot>"   ex.: "eda_original", "colono_slot2"
//
// Cada doc:
//   { snapshot: {...db inteiro...}, salvoEm: <serverTimestamp>,
//     ehOriginal: bool, contagemItens: number }
// ============================================================

(function (global) {
  'use strict';

  var SLOTS = ['original', 'slot1', 'slot2', 'slot3'];

  function docId(tipo, slot) { return tipo + '_' + slot; }

  // Conta itens (entradas com `nome`) num snapshot — usado para
  // mostrar "47 itens" na UI sem precisar abrir o snapshot.
  function contarItens(db) {
    if (!db) return 0;
    var total = 0;
    Object.keys(db).forEach(function (k) {
      if (Array.isArray(db[k])) {
        db[k].forEach(function (it) { if (it && it.nome) total++; });
      }
    });
    return total;
  }

  // Lista todos os 4 slots para um tipo. Slots vazios voltam null.
  function listarBackups(firestore, uid, tipo) {
    return firestore.collection('users').doc(uid)
      .collection('backups').get()
      .then(function (snap) {
        var resultado = { original: null, slot1: null, slot2: null, slot3: null };
        snap.forEach(function (doc) {
          var id = doc.id;
          if (id.indexOf(tipo + '_') !== 0) return;
          var slot = id.substring(tipo.length + 1);
          if (SLOTS.indexOf(slot) !== -1) {
            resultado[slot] = doc.data();
          }
        });
        return resultado;
      });
  }

  // Salva snapshot num slot. Se slot === 'original', falha se já
  // existir (imutabilidade).
  function salvarBackup(firestore, uid, tipo, slot, db) {
    if (SLOTS.indexOf(slot) === -1) {
      return Promise.reject(new Error('Slot inválido: ' + slot));
    }
    if (!db) {
      return Promise.reject(new Error('Sem banco para salvar.'));
    }
    var docRef = firestore.collection('users').doc(uid)
                          .collection('backups').doc(docId(tipo, slot));

    var promiseExiste = (slot === 'original')
      ? docRef.get().then(function (s) {
          if (s.exists) {
            throw new Error('O slot "original" já existe e é imutável.');
          }
        })
      : Promise.resolve();

    return promiseExiste.then(function () {
      return docRef.set({
        snapshot:      JSON.parse(JSON.stringify(db)),
        salvoEm:       firebase.firestore.FieldValue.serverTimestamp(),
        ehOriginal:    (slot === 'original'),
        contagemItens: contarItens(db)
      });
    });
  }

  // Lê snapshot completo de um slot.
  function lerBackup(firestore, uid, tipo, slot) {
    return firestore.collection('users').doc(uid)
      .collection('backups').doc(docId(tipo, slot)).get()
      .then(function (s) {
        if (!s.exists) return null;
        return s.data();
      });
  }

  // Apaga slot. Original NÃO pode ser apagado (rede de segurança).
  function apagarBackup(firestore, uid, tipo, slot) {
    if (slot === 'original') {
      return Promise.reject(new Error('Não é possível apagar o slot "original".'));
    }
    return firestore.collection('users').doc(uid)
      .collection('backups').doc(docId(tipo, slot)).delete();
  }

  // Restaura: aplica snapshot ao campo ativo (dbEDA / dbColono) do
  // documento principal do usuário, com merge para preservar o
  // outro tipo. Retorna o snapshot aplicado para o caller atualizar
  // estado local.
  function restaurarBackup(firestore, uid, tipo, slot) {
    return lerBackup(firestore, uid, tipo, slot).then(function (data) {
      if (!data || !data.snapshot) {
        throw new Error('Slot vazio ou inacessível.');
      }
      var campo = (tipo === 'eda') ? 'dbEDA' : 'dbColono';
      var update = {
        atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
      };
      update[campo] = data.snapshot;
      return firestore.collection('users').doc(uid)
        .set(update, { merge: true })
        .then(function () { return data.snapshot; });
    });
  }

  global.Backup = {
    SLOTS:           SLOTS,
    listarBackups:   listarBackups,
    salvarBackup:    salvarBackup,
    lerBackup:       lerBackup,
    apagarBackup:    apagarBackup,
    restaurarBackup: restaurarBackup,
    contarItens:     contarItens
  };

})(window);
