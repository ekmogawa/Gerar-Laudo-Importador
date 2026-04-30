// ============================================================
// Gerar-Laudo-Importador — Lógica principal
// Fase 1: login, detecção de tipo, leitura do banco do usuário
// ============================================================

// Estado global da aplicação
var _firebase  = null;   // app Firebase
var _auth      = null;   // firebase.auth()
var _firestore = null;   // firebase.firestore()
var _user      = null;   // usuário autenticado (vindo da sessão do gerador)
var _tipo      = null;   // 'eda' ou 'colono'
var _db        = null;   // dbEDA ou dbColono carregado do Firestore
var _config    = null;   // importadorConfig do usuário
var _arquivosPendentes = [];   // [File, ...] selecionados mas ainda não processados
var _resultados        = [];   // resultado do parser_word para cada arquivo
var _matching          = null; // resultado de Matching.analisar (Fase 3)
var _tolerancia        = 50;   // 0-100, calibração ao vivo (Fase 4)
var _pesoConceito      = 0.6;  // 0-1, requer re-rodar matching
var _propostas         = [];   // array de propostas para revisão (Fase 5)
var _filtroRevisao     = 'todos';

var MAX_ARQUIVOS    = 20;
var MAX_BYTES_ARQ   = 10 * 1024 * 1024;   // 10 MB por arquivo (defesa)
var _processando    = false;              // trava a remoção durante processamento

// Seções esperadas (arrays de itens) por especialidade.
// Validadas contra dados_eda.js e dados_colono.js reais.
//
// Atenção (Colono): o app gerador NÃO tem seções por segmento
// (reto, sigmoide, etc.). Tem uma única seção "exame" cujo `valor`
// contém o texto completo do laudo, com <br> separando os segmentos.
// O pipeline de Fase 2/3 precisa tratar isso na decomposição.
//
// Campos do tipo objeto (sedacaoSelects, lesoes, diverticulos,
// canalAnal, conclusaoSimples, conclusaoComposta) ficam fora —
// não são checkboxes editáveis pelo importador.
var SECOES_POR_TIPO = {
  eda: [
    'equipamento', 'sedacao', 'esofago', 'estomago',
    'duodeno', 'jejuno', 'outros', 'conclusao'
  ],
  colono: [
    'indicacao', 'equipamento', 'sedacao', 'preparo',
    'exame', 'conclusao', 'obs', 'outros'
  ]
};

// ------------------------------------------------------------
// Detecção de tipo via parâmetro da URL
// ------------------------------------------------------------
function detectarTipo() {
  var params = new URLSearchParams(window.location.search);
  var tipo = (params.get('tipo') || '').toLowerCase().trim();
  if (tipo !== 'eda' && tipo !== 'colono') {
    return null;
  }
  return tipo;
}

// ------------------------------------------------------------
// Inicialização Firebase
// ------------------------------------------------------------
function inicializarFirebase() {
  _tipo = detectarTipo();
  ajustarTitulo();

  if (!_tipo) {
    mostrarErroFatal(
      'Tipo de laudo não especificado. Use ?tipo=eda ou ?tipo=colono na URL.'
    );
    return;
  }

  try {
    _firebase  = firebase.initializeApp(FIREBASE_CONFIG);
    _auth      = firebase.auth();
    _firestore = firebase.firestore();
  } catch (e) {
    mostrarErroFatal('Falha ao inicializar Firebase: ' + e.message);
    return;
  }

  // O importador é aberto a partir do app gerador, onde o usuário
  // já está autenticado. A sessão do Firebase Auth é compartilhada
  // entre apps na mesma origem (ekmogawa.github.io), portanto este
  // callback dispara já com o usuário definido no fluxo normal.
  // A tela "deslogado" é fallback para quem abre direto pela URL.
  _auth.onAuthStateChanged(function (user) {
    if (user && !user.isAnonymous) {
      _user = user;
      mostrarTelaPrincipal();
      carregarBancoUsuario();
    } else {
      _user = null;
      mostrarTelaDeslogado();
    }
  });
}

// ------------------------------------------------------------
// UI — alternância de telas
// ------------------------------------------------------------
function ajustarTitulo() {
  var tit = document.getElementById('titulo-app');
  var bd  = document.getElementById('tipo-badge');
  if (!tit || !bd) return;
  if (_tipo === 'eda') {
    tit.textContent = 'Importador de Laudos — EDA';
    bd.textContent  = 'EDA';
  } else if (_tipo === 'colono') {
    tit.textContent = 'Importador de Laudos — Colonoscopia';
    bd.textContent  = 'Colono';
  } else {
    tit.textContent = 'Importador de Laudos';
    bd.textContent  = '—';
  }
}

function mostrarTelaDeslogado() {
  document.getElementById('tela-deslogado').classList.remove('hidden');
  document.getElementById('tela-principal').classList.add('hidden');
  document.getElementById('email-usuario').textContent = '';
  document.getElementById('btn-logout').classList.add('hidden');

  // Destaca o gerador correspondente ao tipo atual da URL
  var linkEda    = document.getElementById('link-gerador-eda');
  var linkColono = document.getElementById('link-gerador-colono');
  if (linkEda && linkColono) {
    if (_tipo === 'colono') {
      linkColono.classList.remove('secundaria');
      linkEda.classList.add('secundaria');
    } else {
      linkEda.classList.remove('secundaria');
      linkColono.classList.add('secundaria');
    }
  }

  // Quando o auth state já resolveu e ninguém logou, troca a mensagem
  var info = document.getElementById('info-aguardando');
  if (info) {
    info.textContent =
      'Nenhuma sessão ativa encontrada. Abra um dos geradores e faça login.';
  }
}

function mostrarTelaPrincipal() {
  document.getElementById('tela-deslogado').classList.add('hidden');
  document.getElementById('tela-principal').classList.remove('hidden');
  document.getElementById('email-usuario').textContent = _user.email || '';
  document.getElementById('btn-logout').classList.remove('hidden');
}

function mostrarErroFatal(texto) {
  var box = document.getElementById('msg-erro-fatal');
  if (box) {
    box.textContent = texto;
    box.classList.remove('hidden');
  }
}

// ------------------------------------------------------------
// Logout
// O login é feito sempre pelo app gerador. Aqui só permitimos sair
// (volta para tela "deslogado", que orienta a voltar ao gerador).
// ------------------------------------------------------------
function fazerLogout() {
  _auth.signOut();
}

// ------------------------------------------------------------
// Carregamento do banco do usuário (dbEDA ou dbColono)
// ------------------------------------------------------------
function carregarBancoUsuario() {
  var resumo = document.getElementById('resumo-banco');
  resumo.innerHTML = '<div class="msg info">Carregando banco do usuário...</div>';

  _firestore.collection('users').doc(_user.uid).get()
    .then(function (doc) {
      var campo = (_tipo === 'eda') ? 'dbEDA' : 'dbColono';
      var dados = doc.exists ? (doc.data() || {}) : {};
      _config = dados.importadorConfig || { tolerancia: 50, pesoConceito: 0.6 };

      if (dados[campo]) {
        _db = dados[campo];
        renderizarResumoBanco(_db);
        carregarBackups();
        carregarHistorico();
        return;
      }

      // Primeiro acesso do usuário a este tipo. Faz seed da versão
      // curada pelo admin (visitante/publico) e auto-cria o backup
      // ORIGINAL com esse snapshot. A partir daqui o banco é DELE
      // — não há nova importação do admin posteriormente.
      resumo.innerHTML =
        '<div class="msg info">Inicializando seu banco a partir da versão curada do admin…</div>';
      seedDoAdmin(campo)
        .then(function (db) {
          _db = db;
          renderizarResumoBanco(_db);
          carregarHistorico();
          return carregarBackups();
        })
        .catch(function (err) {
          resumo.innerHTML =
            '<div class="msg erro">Não foi possível inicializar o banco: ' +
            escaparHtml(err.message) + '</div>';
        });
    })
    .catch(function (err) {
      resumo.innerHTML =
        '<div class="msg erro">Erro ao carregar banco: ' + err.message + '</div>';
    });
}

// Seed de primeiro acesso: copia o banco curado pelo admin
// (visitante/publico) para users/{uid}.dbXXX e auto-cria o
// backup original com o MESMO snapshot. Acontece apenas UMA vez,
// quando o usuário ainda não tem o campo dbEDA/dbColono.
function seedDoAdmin(campo) {
  return _firestore.collection('visitante').doc('publico').get()
    .then(function (snap) {
      if (!snap.exists) {
        throw new Error('Banco curado (visitante/publico) não encontrado.');
      }
      var dbAdmin = snap.data() && snap.data()[campo];
      if (!dbAdmin) {
        throw new Error('Banco curado não tem ' +
                        (campo === 'dbEDA' ? 'EDA' : 'Colono') + ' disponível.');
      }
      // Persiste como banco do usuário (merge para não tocar o
      // outro tipo, se houver).
      var update = {
        atualizadoEm: firebase.firestore.FieldValue.serverTimestamp(),
        email:        _user.email
      };
      update[campo] = dbAdmin;
      return _firestore.collection('users').doc(_user.uid)
        .set(update, { merge: true })
        .then(function () {
          // Auto-cria backup original com mesmo snapshot. Idempotente:
          // se já existe (caso raro), apenas warn.
          return Backup.salvarBackup(_firestore, _user.uid, _tipo, 'original', dbAdmin)
            .catch(function (e) {
              console.warn('[seed] backup original já existia ou falhou:', e.message);
            });
        })
        .then(function () { return dbAdmin; });
    });
}

// ============================================================
// Sistema de backup — 4 slots
// ============================================================

function carregarBackups() {
  if (!_user || typeof Backup === 'undefined') return;
  var lista = document.getElementById('lista-backups');
  lista.innerHTML = '<div class="msg info">Carregando…</div>';

  Backup.listarBackups(_firestore, _user.uid, _tipo)
    .then(function (slots) {
      renderizarCardBackup(slots);
    })
    .catch(function (err) {
      lista.innerHTML =
        '<div class="msg erro">Erro ao carregar backups: ' + escaparHtml(err.message) + '</div>';
    });
}

function formatarData(ts) {
  if (!ts) return '—';
  var d = (typeof ts.toDate === 'function') ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderizarCardBackup(slots) {
  var lista = document.getElementById('lista-backups');
  var html = '';

  // ORIGINAL
  var orig = slots.original;
  if (orig) {
    html +=
      '<div class="slot-backup original">' +
        '<div class="slot-info">' +
          '<div class="slot-titulo">Original ' +
            '<span class="badge-imutavel">imutável</span>' +
          '</div>' +
          '<div class="slot-detalhes">' +
            'Criado em ' + escaparHtml(formatarData(orig.salvoEm)) + ' · ' +
            (orig.contagemItens || 0) + ' itens' +
          '</div>' +
        '</div>' +
        '<div class="slot-acoes">' +
          '<button class="restaurar" data-slot="original" type="button">Restaurar</button>' +
        '</div>' +
      '</div>';
  } else {
    html +=
      '<div class="slot-backup original vazio">' +
        '<div class="slot-info">' +
          '<div class="slot-titulo">Original ' +
            '<span class="badge-imutavel">imutável</span>' +
          '</div>' +
          '<div class="slot-detalhes">Ainda não definido. ' +
            'Defina o banco atual como ponto de retorno permanente.' +
          '</div>' +
        '</div>' +
        '<div class="slot-acoes">' +
          '<button class="salvar" data-slot="original" type="button">Definir como original</button>' +
        '</div>' +
      '</div>';
  }

  // SLOTS 1, 2, 3
  ['slot1', 'slot2', 'slot3'].forEach(function (key, idx) {
    var s = slots[key];
    var nome = 'Slot ' + (idx + 1);
    if (s) {
      html +=
        '<div class="slot-backup">' +
          '<div class="slot-info">' +
            '<div class="slot-titulo">' + nome + '</div>' +
            '<div class="slot-detalhes">' +
              'Salvo em ' + escaparHtml(formatarData(s.salvoEm)) + ' · ' +
              (s.contagemItens || 0) + ' itens' +
            '</div>' +
          '</div>' +
          '<div class="slot-acoes">' +
            '<button class="salvar"    data-slot="' + key + '" type="button">Sobrescrever</button>' +
            '<button class="restaurar" data-slot="' + key + '" type="button">Restaurar</button>' +
            '<button class="apagar"    data-slot="' + key + '" type="button">Apagar</button>' +
          '</div>' +
        '</div>';
    } else {
      html +=
        '<div class="slot-backup vazio">' +
          '<div class="slot-info">' +
            '<div class="slot-titulo">' + nome + '</div>' +
            '<div class="slot-detalhes">Vazio</div>' +
          '</div>' +
          '<div class="slot-acoes">' +
            '<button class="salvar" data-slot="' + key + '" type="button">Salvar banco atual aqui</button>' +
          '</div>' +
        '</div>';
    }
  });

  lista.innerHTML = html;

  // Wire dos botões
  lista.querySelectorAll('button.salvar').forEach(function (btn) {
    btn.addEventListener('click', function () { handlerSalvarBackup(btn.dataset.slot); });
  });
  lista.querySelectorAll('button.restaurar').forEach(function (btn) {
    btn.addEventListener('click', function () { handlerRestaurarBackup(btn.dataset.slot); });
  });
  lista.querySelectorAll('button.apagar').forEach(function (btn) {
    btn.addEventListener('click', function () { handlerApagarBackup(btn.dataset.slot); });
  });
}

function bloquearBotoesBackup(travar) {
  document.querySelectorAll('#lista-backups button').forEach(function (b) {
    b.disabled = !!travar;
  });
}

function handlerSalvarBackup(slot) {
  if (!_db) {
    alert('Sem banco carregado. Carregue antes de salvar backup.');
    return;
  }
  var rotulo = (slot === 'original') ? 'o slot ORIGINAL (imutável)'
                                      : 'o ' + slot.toUpperCase();
  if (!confirm('Salvar o banco atual em ' + rotulo + '?\n\n' +
               'Itens: ' + Backup.contarItens(_db) +
               (slot === 'original'
                 ? '\n\nATENÇÃO: o slot original não pode ser alterado depois.'
                 : ''))) {
    return;
  }
  bloquearBotoesBackup(true);
  Backup.salvarBackup(_firestore, _user.uid, _tipo, slot, _db)
    .then(function () { return carregarBackups(); })
    .catch(function (err) {
      alert('Falha ao salvar: ' + err.message);
      bloquearBotoesBackup(false);
    });
}

function handlerRestaurarBackup(slot) {
  if (!confirm('RESTAURAR ' + slot.toUpperCase() + ' agora?\n\n' +
               'Isto vai SUBSTITUIR o banco ativo (' +
               (_tipo === 'eda' ? 'dbEDA' : 'dbColono') + ') por este snapshot.\n\n' +
               'Os apps geradores irão refletir esta versão na próxima leitura.\n\n' +
               'Uma entrada de auditoria será adicionada ao histórico.\n\n' +
               'Tem certeza?')) {
    return;
  }
  bloquearBotoesBackup(true);
  var dbAntes = _db ? JSON.parse(JSON.stringify(_db)) : null;
  var campo   = (_tipo === 'eda') ? 'dbEDA' : 'dbColono';

  Backup.restaurarBackup(_firestore, _user.uid, _tipo, slot)
    .then(function (snapshot) {
      _db = snapshot;
      // Cria entrada no histórico (origem='backup-restore') —
      // permite reverter o restore via aba histórico, mantém audit
      // trail completo.
      var ts = new Date().toISOString();
      var auditoria = {
        tipo:                _tipo,
        origem:              'backup-restore',
        slotRestaurado:      slot,
        realizadoEm:         firebase.firestore.FieldValue.serverTimestamp(),
        arquivosProcessados: [],
        toleranciaUsada:     null,
        pesoConceitoUsado:   null,
        dbAnterior:          dbAntes,
        alteracoes:          [{
          secao: '(banco inteiro)',
          tipo:  'backup-restore',
          nome:  'Restauração do ' + slot
        }]
      };
      var p = _firestore.collection('users').doc(_user.uid)
                .collection('imports').doc(ts).set(auditoria);

      // Sync admin
      if (_user.email === 'ekmogawa@gmail.com') {
        var pub = {};
        pub[campo] = snapshot;
        var pSync = _firestore.collection('visitante').doc('publico')
          .set(pub, { merge: true })
          .catch(function (e) { console.warn('[visitante sync restore]', e); });
        return Promise.all([p, pSync]);
      }
      return p;
    })
    .then(function () {
      renderizarResumoBanco(_db);
      alert('✓ Backup ' + slot + ' restaurado.');
      carregarBackups();
      carregarHistorico();
    })
    .catch(function (err) {
      alert('Falha ao restaurar: ' + err.message);
      bloquearBotoesBackup(false);
    });
}

function handlerApagarBackup(slot) {
  if (!confirm('Apagar o ' + slot.toUpperCase() + '?\n\nEssa ação não pode ser desfeita.')) {
    return;
  }
  bloquearBotoesBackup(true);
  Backup.apagarBackup(_firestore, _user.uid, _tipo, slot)
    .then(function () { return carregarBackups(); })
    .catch(function (err) {
      alert('Falha ao apagar: ' + err.message);
      bloquearBotoesBackup(false);
    });
}

function renderizarResumoBanco(db) {
  var canonicas = SECOES_POR_TIPO[_tipo] || [];

  // Inclui também seções que o usuário tenha no banco mas que não
  // estão na lista canônica (proteção contra evolução do schema).
  var extras = Object.keys(db).filter(function (k) {
    return canonicas.indexOf(k) === -1 && Array.isArray(db[k]);
  });
  var secoes = canonicas.concat(extras);

  var totalItens = 0;
  var secoesPreenchidas = 0;
  var html = '<div class="secoes-grid">';

  secoes.forEach(function (chave) {
    var arr = Array.isArray(db[chave]) ? db[chave] : [];
    // Conta apenas itens com nome (ignora separadores: { separador: true })
    var qtd = arr.filter(function (it) { return it && it.nome; }).length;
    totalItens += qtd;
    if (qtd > 0) secoesPreenchidas++;
    var marcaExtra = (extras.indexOf(chave) !== -1)
      ? ' <span title="Seção fora da lista canônica" style="color:#888">*</span>'
      : '';
    html += '<div class="secao-card">' +
              '<div class="nome">' + escaparHtml(chave) + marcaExtra + '</div>' +
              '<div class="qtd">' + qtd + '</div>' +
            '</div>';
  });

  html += '</div>';

  var rotuloTipo = (_tipo === 'eda') ? 'dbEDA' : 'dbColono';
  var cabecalho =
    '<p><strong>' + rotuloTipo + ' carregado:</strong> ' +
    totalItens + ' ' + (totalItens === 1 ? 'item' : 'itens') +
    ' em ' + secoesPreenchidas + ' ' +
    (secoesPreenchidas === 1 ? 'seção' : 'seções') + '.</p>';

  var cfg =
    '<p style="font-size:12px;color:#666;margin-top:12px;">' +
    'Configuração do importador: tolerância ' + _config.tolerancia +
    ', peso conceito ' + _config.pesoConceito + '.</p>';

  document.getElementById('resumo-banco').innerHTML = cabecalho + html + cfg;
}

// Escape básico para evitar quebra/HTML injection ao exibir nome de seção
function escaparHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================
// Fase 2 — Upload e parsing
// ============================================================

// ------------------------------------------------------------
// Seleção de arquivos (drag-drop + input)
// ------------------------------------------------------------
function configurarUpload() {
  var zona  = document.getElementById('zona-upload');
  var input = document.getElementById('input-arquivos');
  var btnSelecionar = document.getElementById('btn-selecionar');
  var btnLimpar     = document.getElementById('btn-limpar');
  var btnProcessar  = document.getElementById('btn-processar');

  if (!zona || !input) return;

  btnSelecionar.addEventListener('click', function () { input.click(); });

  input.addEventListener('change', function () {
    receberArquivos(Array.prototype.slice.call(input.files || []));
    input.value = '';
  });

  // Drag-drop. preventDefault em dragover é obrigatório para
  // permitir o drop, e dragenter/dragleave dão feedback visual.
  ['dragenter', 'dragover'].forEach(function (ev) {
    zona.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      zona.classList.add('arrastando');
    });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    zona.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      zona.classList.remove('arrastando');
    });
  });
  zona.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    zona.classList.remove('arrastando');
    if (e.dataTransfer && e.dataTransfer.files) {
      receberArquivos(Array.prototype.slice.call(e.dataTransfer.files));
    }
  });

  btnLimpar.addEventListener('click', limparArquivos);
  btnProcessar.addEventListener('click', processarTudo);
}

function receberArquivos(novos) {
  if (_processando) {
    alert('Aguarde o processamento atual terminar antes de adicionar mais arquivos.');
    return;
  }

  var problemas = [];

  // Filtros: extensão, tamanho, duplicatas
  novos.forEach(function (f) {
    if (!/\.docx$/i.test(f.name)) {
      problemas.push(f.name + ' — não é .docx');
      return;
    }
    if (f.size > MAX_BYTES_ARQ) {
      problemas.push(f.name + ' — maior que ' +
                     Math.round(MAX_BYTES_ARQ / 1024 / 1024) + ' MB');
      return;
    }
    var jaTem = _arquivosPendentes.some(function (x) {
      return x.name === f.name && x.size === f.size;
    });
    if (jaTem) return;  // duplicata silenciosa

    if (_arquivosPendentes.length >= MAX_ARQUIVOS) {
      problemas.push(f.name + ' — limite de ' + MAX_ARQUIVOS + ' arquivos atingido');
      return;
    }
    _arquivosPendentes.push(f);
  });

  if (problemas.length) {
    alert('Alguns arquivos foram ignorados:\n\n• ' + problemas.join('\n• '));
  }

  renderizarListaArquivos();
}

function limparArquivos() {
  _arquivosPendentes = [];
  _resultados = [];
  _matching = null;
  _propostas = [];
  renderizarListaArquivos();
  document.getElementById('card-resultado').classList.add('hidden');
  document.getElementById('card-matching').classList.add('hidden');
  document.getElementById('card-revisao').classList.add('hidden');
}

function renderizarListaArquivos() {
  var ul = document.getElementById('lista-arquivos');
  var acoes = document.getElementById('acoes-upload');
  var btnProcessar = document.getElementById('btn-processar');

  ul.innerHTML = '';
  if (_arquivosPendentes.length === 0) {
    acoes.classList.add('hidden');
    return;
  }
  acoes.classList.remove('hidden');
  btnProcessar.disabled = false;

  _arquivosPendentes.forEach(function (f, idx) {
    var li = document.createElement('li');
    li.dataset.idx = String(idx);
    var btnRemoverDisabled = _processando ? ' disabled' : '';
    li.innerHTML =
      '<span class="nome-arquivo">' + escaparHtml(f.name) + '</span>' +
      '<span class="status pendente">pendente</span>' +
      '<button class="remover" type="button" title="Remover"' +
        btnRemoverDisabled + '>×</button>';
    li.querySelector('.remover').addEventListener('click', function () {
      if (_processando) return;
      _arquivosPendentes.splice(idx, 1);
      renderizarListaArquivos();
    });
    ul.appendChild(li);
  });
}

function definirStatusArquivo(idx, classe, texto) {
  var ul = document.getElementById('lista-arquivos');
  var li = ul.querySelector('li[data-idx="' + idx + '"]');
  if (!li) return;
  var span = li.querySelector('.status');
  span.className = 'status ' + classe;
  span.textContent = texto;
}

// ------------------------------------------------------------
// Processamento dos arquivos (delegado ao ParserWord)
// ------------------------------------------------------------
function processarTudo() {
  if (!global_ParserWord()) return;
  if (_arquivosPendentes.length === 0) return;

  _processando = true;
  var btnProcessar = document.getElementById('btn-processar');
  var btnLimpar    = document.getElementById('btn-limpar');
  btnProcessar.disabled = true;
  btnLimpar.disabled    = true;
  btnProcessar.textContent = 'Processando...';
  // Re-render para desabilitar botões "remover"
  renderizarListaArquivos();

  ParserWord.processarArquivos(_arquivosPendentes, _tipo, {
    aoIniciar: function (idx) {
      definirStatusArquivo(idx, 'processando', 'processando…');
    },
    aoConcluir: function (idx, resultado) {
      var totalSec = resultado.secoes.length;
      var totalCla = resultado.secoes.reduce(function (acc, s) {
        return acc + s.clausulas.length;
      }, 0);
      var rotulo = totalSec + ' seç · ' + totalCla + ' cláus';
      if (resultado.sentencasInferidas) {
        rotulo += ' · ' + resultado.sentencasInferidas + ' inferida' +
                  (resultado.sentencasInferidas === 1 ? '' : 's');
      }
      if (resultado.imagensDescartadas) {
        rotulo += ' · ' + resultado.imagensDescartadas + ' img';
      }
      definirStatusArquivo(idx, 'ok', rotulo);
    },
    aoFalhar: function (idx, file, err) {
      definirStatusArquivo(idx, 'erro', 'erro');
      console.error('[parser]', file.name, err);
    }
  }).then(function (resultados) {
    _resultados = resultados;
    _processando = false;
    btnProcessar.textContent = 'Processar arquivos';
    btnProcessar.disabled = false;
    btnLimpar.disabled    = false;
    renderizarArvore();
    renderizarListaArquivosPreservandoStatus();
    // Fase 3 — matching contra o banco do usuário
    rodarMatching();
  });
}

// ============================================================
// Fase 3 — Matching conceitual e tabelas de debug
// ============================================================
function rodarMatching() {
  var card = document.getElementById('card-matching');
  if (typeof Matching === 'undefined') {
    console.error('matching.js não carregou');
    card.classList.add('hidden');
    return;
  }
  if (!_db) {
    document.getElementById('resumo-matching').innerHTML =
      '<div class="msg info">Sem banco do usuário carregado — pulando matching.</div>';
    card.classList.remove('hidden');
    return;
  }
  if (!_resultados || _resultados.every(function (r) { return r.erro; })) {
    card.classList.add('hidden');
    return;
  }

  // Lê config persistida na sessão atual (slider) ou no banco do usuário
  if (_config) {
    if (typeof _config.tolerancia   === 'number') _tolerancia   = _config.tolerancia;
    if (typeof _config.pesoConceito === 'number') _pesoConceito = _config.pesoConceito;
  }
  document.getElementById('slider-tolerancia').value = String(_tolerancia);
  document.getElementById('valor-tolerancia').textContent = String(_tolerancia);
  document.getElementById('slider-peso').value = String(Math.round(_pesoConceito * 100));
  document.getElementById('valor-peso').textContent = _pesoConceito.toFixed(2);

  var t0 = performance.now();
  _matching = Matching.analisar(_resultados, _db, {
    pesoConceito:       _pesoConceito,
    topN:               8,
    tamanhoMaxJanela:   4,
    thresholdCobertura: 0.50,
    limiarMatch:        0.65,
    diceThreshold:      0.85,
    diceThresholdNovos: 0.65
  });
  var ms = Math.round(performance.now() - t0);

  card.classList.remove('hidden');
  renderizarResumoMatching(ms);
  renderizarTabelaScores();
  renderizarTabelaNovos();
  renderizarTabelaConsenso();
  renderizarTabelaPerfil();

  // Aplica classificação inicial conforme a tolerância atual
  aplicarTolerancia(_tolerancia);

  // Fase 5 — gera lista de propostas para revisão
  gerarPropostas();
  renderizarRevisao();
}

function renderizarResumoMatching(ms) {
  var totalArquivos = _matching.porArquivo.length;
  var totalMatches = 0;
  var matchesComMelhor = 0;
  var soma = 0;
  var totalNovos = 0;

  _matching.porArquivo.forEach(function (pa) {
    (pa.secoes || []).forEach(function (sec) {
      (sec.matchesPorItem || []).forEach(function (mpi) {
        totalMatches++;
        if (mpi.melhor) {
          matchesComMelhor++;
          soma += mpi.melhor.score.final;
        }
      });
      totalNovos += (sec.itensNovos || []).length;
    });
  });
  var media = matchesComMelhor ? (soma / matchesComMelhor) : 0;

  var consensoTotal = 0;
  Object.keys(_matching.consenso || {}).forEach(function (s) {
    consensoTotal += _matching.consenso[s].length;
  });

  document.getElementById('resumo-matching').innerHTML =
    '<p>' + totalArquivos + ' arquivo(s) · ' +
    totalMatches + ' busca(s) item × seção · ' +
    matchesComMelhor + ' com janela candidata · ' +
    'score médio ' + media.toFixed(2) + ' · ' +
    totalNovos + ' candidato(s) a item novo · ' +
    'tempo: ' + ms + ' ms</p>';
}

function classeScore(valor) {
  if (valor === null || typeof valor === 'undefined') return 'novo';
  if (valor >= 0.65) return 'alto';
  if (valor >= 0.45) return 'medio';
  return 'baixo';
}

function fmt(n) {
  return (n === null || typeof n === 'undefined') ? '—' : Number(n).toFixed(2);
}

// ============================================================
// Fase 5 — Geração e revisão de propostas
// ============================================================

// Gera _propostas a partir de _matching.consenso (atualizações de
// itens existentes) e _matching.consensoNovos (sugestões de novos
// itens). Roda uma vez após cada Matching.analisar — não depende
// da tolerância (a classificação aplicada à proposta é dinâmica).
//
// Preserva o status das propostas anteriores por id (caso o usuário
// já tenha aceito/editado/ignorado e o matching seja re-rodado por
// mudança no peso conceito). Decisões 'aplicada' (irreversível) são
// mantidas; 'editando' não é restaurado para evitar reabrir form.
function gerarPropostas() {
  var statusAnterior = {};
  _propostas.forEach(function (p) {
    statusAnterior[p.id] = {
      status:       p.status,
      textoEditado: p.textoEditado,
      nomeEditado:  p.nomeEditado
    };
  });
  _propostas = [];
  if (!_matching) return;

  // 1) Atualizações: para cada item do banco com candidato no consenso
  Object.keys(_matching.consenso || {}).forEach(function (secao) {
    _matching.consenso[secao].forEach(function (entry) {
      if (!entry.grupoConsenso) return;
      var item = entry.item;
      var idItem = item.id || item.nome || 'sem-id';
      // Score do membro mais alto do grupo consenso (representa a versão consensus)
      var scoreTopo = entry.grupoConsenso.membros[0]
        ? entry.grupoConsenso.membros[0].score : null;
      _propostas.push({
        id:             'upd-' + secao + '-' + idItem,
        tipo:           'atualizacao',
        secao:          secao,
        item:           item,
        textoBanco:     item.valor || '',
        textoProposta:  entry.grupoConsenso.representante,
        score:          scoreTopo,
        frequencia:     entry.frequenciaArquivos,
        totalArquivos:  _matching.porArquivo.length,
        variantes:      entry.variantes.length,
        status:         'pendente',
        textoEditado:   null
      });
    });
  });

  // 2) Novos: cada cluster de itensNovos vira uma proposta
  Object.keys(_matching.consensoNovos || {}).forEach(function (secao) {
    _matching.consensoNovos[secao].forEach(function (g, idx) {
      _propostas.push({
        id:             'new-' + secao + '-' + idx,
        tipo:           'novo',
        secao:          secao,
        item:           null,
        nomeSugerido:   sugerirNomeNovo(g.representante),
        textoBanco:     '',
        textoProposta:  g.representante,
        score:          null,
        frequencia:     g.frequenciaArquivos,
        totalArquivos:  _matching.porArquivo.length,
        variantes:      g.totalCandidatos - 1,
        status:         'pendente',
        textoEditado:   null,
        nomeEditado:    null
      });
    });
  });

  // Restaura decisões anteriores casando por id. 'editando' vira
  // 'pendente' (form fica fechado após re-render). 'aplicada' é
  // estado terminal e mantém — não permite mais ações.
  _propostas.forEach(function (p) {
    var prev = statusAnterior[p.id];
    if (!prev) return;
    if (prev.status === 'aplicada' ||
        prev.status === 'aceita'   ||
        prev.status === 'ignorada' ||
        prev.status === 'editada') {
      p.status = prev.status;
      if (prev.textoEditado != null) p.textoEditado = prev.textoEditado;
      if (prev.nomeEditado  != null) p.nomeEditado  = prev.nomeEditado;
    }
  });
}

// Heurística: usa as primeiras 3 palavras do trecho como sugestão de nome.
function sugerirNomeNovo(texto) {
  if (!texto) return 'novo item';
  var palavras = String(texto).replace(/[<>]/g, '').split(/\s+/).filter(Boolean);
  return palavras.slice(0, 3).join(' ').replace(/[.,;:!?]+$/, '');
}

// Classificação atual da proposta dada a tolerância em curso.
// Atualizações: depende de score.final.
// Novos: classificação fixa 'novo' (alta freq) ou 'variante' (baixa freq).
function classificarProposta(p) {
  if (p.tipo === 'novo') {
    var ratio = p.totalArquivos ? (p.frequencia / p.totalArquivos) : 0;
    return (ratio < 0.30) ? 'variante' : 'novo';
  }
  // Atualização: classifica pelo score final
  return Matching.classificarScore(p.score ? p.score.final : null, _tolerancia);
}

// Diff palavra-a-palavra via LCS. Retorna lista de
// { type: 'keep'|'add'|'rem', value: '...' }.
function diffPalavras(antes, depois) {
  var a = String(antes || '').split(/(\s+)/);  // mantém whitespace como tokens
  var b = String(depois || '').split(/(\s+)/);
  var m = a.length, n = b.length;

  // dp[i][j] = LCS de a[..i] e b[..j]
  var dp = [];
  for (var i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
  for (var i = 1; i <= m; i++) {
    for (var j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  var ops = [];
  var i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.unshift({ type: 'keep', value: a[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.unshift({ type: 'rem', value: a[i - 1] });
      i--;
    } else {
      ops.unshift({ type: 'add', value: b[j - 1] });
      j--;
    }
  }
  while (i > 0) ops.unshift({ type: 'rem', value: a[--i] });
  while (j > 0) ops.unshift({ type: 'add', value: b[--j] });
  return ops;
}

function renderizarDiff(antes, depois) {
  var ops = diffPalavras(antes, depois);
  return ops.map(function (op) {
    if (op.type === 'keep') return '<span class="diff-keep">' + escaparHtml(op.value) + '</span>';
    if (op.type === 'add')  return '<span class="diff-add">'  + escaparHtml(op.value) + '</span>';
    if (op.type === 'rem')  return '<span class="diff-rem">'  + escaparHtml(op.value) + '</span>';
    return '';
  }).join('');
}

function renderizarRevisao() {
  var card = document.getElementById('card-revisao');
  if (!_propostas.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  renderizarListaPropostas();
  atualizarContadorRevisao();
}

function classificacaoCorrespondeFiltro(p, classificacao, filtro) {
  switch (filtro) {
    case 'todos':       return true;
    case 'atualizacao': return p.tipo === 'atualizacao' && classificacao === 'atualizacao';
    case 'novo':        return p.tipo === 'novo';
    case 'variante':    return classificacao === 'variante';
    case 'pendentes':   return p.status === 'pendente';
    default:            return true;
  }
}

function renderizarListaPropostas() {
  var lista = document.getElementById('lista-propostas');
  // Agrupa por seção, em ordem canônica do tipo
  var ordemSecoes = SECOES_POR_TIPO[_tipo] || [];
  var porSecao = {};
  ordemSecoes.forEach(function (s) { porSecao[s] = []; });

  var visiveis = 0;
  _propostas.forEach(function (p) {
    var classif = classificarProposta(p);
    if (!classificacaoCorrespondeFiltro(p, classif, _filtroRevisao)) return;
    if (!porSecao[p.secao]) porSecao[p.secao] = [];
    porSecao[p.secao].push({ p: p, classif: classif });
    visiveis++;
  });

  if (visiveis === 0) {
    lista.innerHTML = '<div class="proposta-vazia">' +
      'Nenhuma proposta corresponde ao filtro "' + escaparHtml(_filtroRevisao) + '".' +
      '</div>';
    return;
  }

  var html = '';
  Object.keys(porSecao).forEach(function (secao) {
    var items = porSecao[secao];
    if (!items.length) return;
    html += '<div class="secao-revisao">' +
              '<h3>' + escaparHtml(secao) + ' · ' + items.length + '</h3>';
    items.forEach(function (entry) {
      html += renderizarUmaProposta(entry.p, entry.classif);
    });
    html += '</div>';
  });
  lista.innerHTML = html;

  // Wire dos botões + listeners ao vivo nos campos de edição.
  // Os listeners 'input' sincronizam textoEditado/nomeEditado em
  // _propostas a cada keystroke; sem isso, re-renders disparados
  // pelo slider de tolerância destruiriam o que foi digitado.
  lista.querySelectorAll('.proposta').forEach(function (el) {
    var id = el.dataset.id;
    var p = _propostas.filter(function (x) { return x.id === id; })[0];

    el.querySelector('button.aceitar')
      .addEventListener('click', function () { acaoProposta(id, 'aceitar'); });
    el.querySelector('button.ignorar')
      .addEventListener('click', function () { acaoProposta(id, 'ignorar'); });
    el.querySelector('button.editar')
      .addEventListener('click', function () { acaoProposta(id, 'editar'); });
    var btnSalvar = el.querySelector('button.salvar-edicao');
    if (btnSalvar) {
      btnSalvar.addEventListener('click', function () { acaoProposta(id, 'salvar'); });
    }
    var btnCancelar = el.querySelector('button.cancelar-edicao');
    if (btnCancelar) {
      btnCancelar.addEventListener('click', function () { acaoProposta(id, 'cancelar'); });
    }

    // Persiste edição em curso a cada tecla
    var ta = el.querySelector('textarea.input-texto');
    if (ta && p) {
      ta.addEventListener('input', function () { p.textoEditado = ta.value; });
    }
    var inN = el.querySelector('input.input-nome');
    if (inN && p) {
      inN.addEventListener('input', function () { p.nomeEditado = inN.value; });
    }
  });
}

function renderizarUmaProposta(p, classif) {
  var freqRatio = p.totalArquivos ? (p.frequencia / p.totalArquivos) : 0;
  var ehBaixa = freqRatio < 0.30;

  var titulo = (p.tipo === 'novo')
    ? 'Novo item: <em>' + escaparHtml(p.nomeEditado || p.nomeSugerido) + '</em>'
    : escaparHtml(p.item.nome || p.item.id || '?');

  var scoreTooltip = p.score
    ? 'title="Conceito: ' + p.score.conceito.toFixed(2) +
      ', Superfície: ' + p.score.superficie.toFixed(2) +
      ', Final: ' + p.score.final.toFixed(2) + '"'
    : '';

  var rotuloFreq = (p.tipo === 'novo' && ehBaixa) ? ' (baixa confiança)' : '';
  var freqHtml = '<span class="freq-badge' + (ehBaixa ? ' baixa' : '') + '" ' + scoreTooltip + '>' +
                 'em ' + p.frequencia + ' de ' + p.totalArquivos + ' laudos' + rotuloFreq + '</span>';

  var blocos = '';
  if (p.tipo === 'atualizacao') {
    blocos +=
      '<div class="proposta-bloco atual">' +
        '<div class="rotulo">Texto atual no banco</div>' +
        '<div class="corpo">' + escaparHtml(p.textoBanco) + '</div>' +
      '</div>' +
      '<div class="proposta-bloco proposto">' +
        '<div class="rotulo">Versão consenso dos laudos</div>' +
        '<div class="corpo">' + escaparHtml(p.textoProposta) + '</div>' +
      '</div>' +
      '<div class="proposta-bloco diff">' +
        '<div class="rotulo">Diff (verde = adicionar, vermelho riscado = remover)</div>' +
        '<div class="corpo">' + renderizarDiff(p.textoBanco, p.textoEditado || p.textoProposta) + '</div>' +
      '</div>';
  } else {
    blocos +=
      '<div class="proposta-bloco proposto">' +
        '<div class="rotulo">Texto extraído dos laudos</div>' +
        '<div class="corpo">' + escaparHtml(p.textoEditado || p.textoProposta) + '</div>' +
      '</div>';
  }

  // Edição inline
  var blocoEdicao = '';
  if (p.status === 'editando') {
    if (p.tipo === 'novo') {
      blocoEdicao =
        '<div class="proposta-edicao">' +
          '<label>Nome do item</label>' +
          '<input class="input-nome" value="' +
            escaparHtml(p.nomeEditado || p.nomeSugerido) + '">' +
          '<label>Texto</label>' +
          '<textarea class="input-texto">' +
            escaparHtml(p.textoEditado || p.textoProposta) + '</textarea>' +
          '<div style="margin-top:6px;display:flex;gap:6px;">' +
            '<button class="acao salvar-edicao" type="button">Salvar e aceitar</button>' +
            '<button class="acao secundaria cancelar-edicao" type="button">Cancelar</button>' +
          '</div>' +
        '</div>';
    } else {
      blocoEdicao =
        '<div class="proposta-edicao">' +
          '<label>Texto editado</label>' +
          '<textarea class="input-texto">' +
            escaparHtml(p.textoEditado || p.textoProposta) + '</textarea>' +
          '<div style="margin-top:6px;display:flex;gap:6px;">' +
            '<button class="acao salvar-edicao" type="button">Salvar e aceitar</button>' +
            '<button class="acao secundaria cancelar-edicao" type="button">Cancelar</button>' +
          '</div>' +
        '</div>';
    }
  }

  var classeStatus = (p.status === 'aceita')   ? 'aceita'
                   : (p.status === 'ignorada') ? 'ignorada'
                   : (p.status === 'editada')  ? 'editada' : '';

  return (
    '<div class="proposta ' + classeStatus + '" data-id="' + escaparHtml(p.id) + '">' +
      '<div class="proposta-cabecalho">' +
        '<span class="badge-cls ' + classif + '">' + rotuloClassificacao(classif) + '</span>' +
        '<span class="proposta-titulo">' + titulo + '</span>' +
        '<span class="proposta-meta">' + freqHtml + ' · status: ' +
          escaparHtml(p.status) + '</span>' +
      '</div>' +
      '<div class="proposta-corpo">' + blocos + blocoEdicao + '</div>' +
      '<div class="proposta-acoes">' +
        '<button class="aceitar" type="button">Aceitar</button>' +
        '<button class="ignorar" type="button">Ignorar</button>' +
        '<button class="editar"  type="button">Editar</button>' +
      '</div>' +
    '</div>'
  );
}

function acaoProposta(id, acao) {
  var p = _propostas.filter(function (x) { return x.id === id; })[0];
  if (!p) return;

  if (acao === 'aceitar')  p.status = 'aceita';
  if (acao === 'ignorar')  p.status = 'ignorada';
  if (acao === 'editar')   p.status = 'editando';

  if (acao === 'salvar') {
    // Lê valores do form da proposta
    var card = document.querySelector('.proposta[data-id="' + id + '"]');
    if (card) {
      var ta = card.querySelector('textarea.input-texto');
      if (ta) p.textoEditado = ta.value;
      var inN = card.querySelector('input.input-nome');
      if (inN) p.nomeEditado = inN.value;
    }
    p.status = 'editada';
  }

  if (acao === 'cancelar') {
    p.status = 'pendente';
    p.textoEditado = null;
    p.nomeEditado = null;
  }

  renderizarListaPropostas();
  atualizarContadorRevisao();
}

function atualizarContadorRevisao() {
  var revisados = _propostas.filter(function (p) {
    return p.status !== 'pendente' && p.status !== 'editando';
  }).length;
  document.getElementById('contador-revisao').textContent =
    revisados + ' de ' + _propostas.length + ' propostas revisadas';

  var btnAplicar = document.getElementById('btn-aplicar');
  // Per PLANO §5.8: o botão Aplicar só fica ativo após o usuário ter
  // revisado pelo menos uma proposta (qualquer ação não-pendente).
  btnAplicar.disabled = (revisados === 0);
}

function configurarFiltrosRevisao() {
  document.querySelectorAll('.filtro-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.filtro-btn').forEach(function (b) {
        b.classList.remove('ativo');
      });
      btn.classList.add('ativo');
      _filtroRevisao = btn.dataset.filtro;
      renderizarListaPropostas();
    });
  });

  document.getElementById('btn-aceitar-matches').addEventListener('click', function () {
    _propostas.forEach(function (p) {
      if (p.tipo === 'atualizacao' &&
          classificarProposta(p) === 'match' &&
          p.status === 'pendente') {
        p.status = 'aceita';
      }
    });
    renderizarListaPropostas();
    atualizarContadorRevisao();
  });

  document.getElementById('btn-ignorar-variantes').addEventListener('click', function () {
    _propostas.forEach(function (p) {
      if (classificarProposta(p) === 'variante' && p.status === 'pendente') {
        p.status = 'ignorada';
      }
    });
    renderizarListaPropostas();
    atualizarContadorRevisao();
  });

  document.getElementById('btn-aplicar').addEventListener('click', aplicarAlteracoes);
}

// ============================================================
// Fase 6 — Gravação atômica + snapshot + histórico
// ============================================================

// Modal genérico de confirmação. cb é chamado se o usuário confirmar.
function abrirModal(titulo, htmlConteudo, cb) {
  var ov = document.getElementById('modal-overlay');
  document.getElementById('modal-titulo').textContent = titulo;
  document.getElementById('modal-conteudo').innerHTML = htmlConteudo;

  var btnConfirmar = document.getElementById('modal-confirmar');
  var btnCancelar  = document.getElementById('modal-cancelar');
  // Clona para limpar listeners anteriores
  var novoConfirmar = btnConfirmar.cloneNode(true);
  btnConfirmar.parentNode.replaceChild(novoConfirmar, btnConfirmar);
  var novoCancelar = btnCancelar.cloneNode(true);
  btnCancelar.parentNode.replaceChild(novoCancelar, btnCancelar);

  novoConfirmar.addEventListener('click', function () {
    fecharModal();
    cb();
  });
  novoCancelar.addEventListener('click', fecharModal);
  ov.classList.remove('hidden');
}

function fecharModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// Constrói o novo `_db` a partir de _propostas aceitas/editadas.
// Retorna { novoDb, alteracoes } sem mutar _db. Mudanças "match" que
// só re-aceitam o valor existente também aparecem em alteracoes
// (transparência), mas com valorAntigo === valorNovo.
function construirNovoDb() {
  var novoDb = JSON.parse(JSON.stringify(_db || {}));
  var alteracoes = [];

  _propostas.forEach(function (p) {
    if (p.status !== 'aceita' && p.status !== 'editada') return;

    if (p.tipo === 'atualizacao') {
      var arr = novoDb[p.secao];
      if (!Array.isArray(arr)) return;
      var idx = arr.findIndex(function (it) {
        if (!it) return false;
        if (p.item.id   && it.id   === p.item.id)   return true;
        if (p.item.nome && it.nome === p.item.nome) return true;
        return false;
      });
      if (idx === -1) return;
      var novoValor = (p.status === 'editada' && p.textoEditado != null)
        ? p.textoEditado : p.textoProposta;
      var antigo = arr[idx].valor || '';
      if (antigo === novoValor) return;  // no-op (match já aceito)
      arr[idx].valor = novoValor;
      alteracoes.push({
        secao:       p.secao,
        tipo:        'atualizacao',
        nome:        p.item.nome || p.item.id || '?',
        valorAntigo: antigo,
        valorNovo:   novoValor
      });
    } else if (p.tipo === 'novo') {
      if (!Array.isArray(novoDb[p.secao])) novoDb[p.secao] = [];
      var nome  = (p.nomeEditado  != null && p.nomeEditado.trim())  || p.nomeSugerido;
      var valor = (p.textoEditado != null && p.textoEditado.length) || p.textoProposta;
      var novoItem = { nome: nome, valor: valor };
      novoDb[p.secao].push(novoItem);
      alteracoes.push({
        secao: p.secao,
        tipo:  'novo',
        nome:  nome,
        valor: valor
      });
    }
  });

  return { novoDb: novoDb, alteracoes: alteracoes };
}

function aplicarAlteracoes() {
  if (!_db || !_propostas.length) return;
  var build = construirNovoDb();
  if (build.alteracoes.length === 0) {
    alert('Nenhuma alteração para aplicar.\n\n' +
          'Aceite ou edite ao menos uma proposta antes de gravar.');
    return;
  }

  var qAtualizacoes = build.alteracoes.filter(function (a) {
    return a.tipo === 'atualizacao';
  }).length;
  var qNovos = build.alteracoes.filter(function (a) {
    return a.tipo === 'novo';
  }).length;

  var rotuloTipo = (_tipo === 'eda') ? 'EDA' : 'Colonoscopia';

  // Modal de confirmação dupla (PLANO §5.8 / §9.5)
  var html =
    '<p>Você está prestes a aplicar no banco da especialidade <strong>' +
      escaparHtml(rotuloTipo) + '</strong>:</p>' +
    '<ul class="resumo-mudancas">' +
      '<li><strong>' + qAtualizacoes + '</strong> atualização(ões) de itens existentes</li>' +
      '<li><strong>' + qNovos + '</strong> novo(s) item(s)</li>' +
    '</ul>' +
    '<p style="font-size:12px;color:#666;">Antes da gravação, um snapshot do banco ' +
    'atual será salvo em <code>users/{uid}/imports/{timestamp}</code> para reversão. ' +
    'Os apps geradores irão refletir as mudanças na próxima leitura.</p>';

  abrirModal('Confirmar aplicação no Firebase', html, function () {
    gravarTudo(build);
  });
}

function gravarTudo(build) {
  var btnAplicar = document.getElementById('btn-aplicar');
  btnAplicar.disabled = true;
  btnAplicar.textContent = 'Gravando…';

  var ts = new Date().toISOString();
  var importDoc = {
    tipo:                _tipo,
    origem:              'import',
    realizadoEm:         firebase.firestore.FieldValue.serverTimestamp(),
    arquivosProcessados: (_resultados || []).map(function (r) { return r.arquivo; }),
    toleranciaUsada:     _tolerancia,
    pesoConceitoUsado:   _pesoConceito,
    dbAnterior:          JSON.parse(JSON.stringify(_db)),
    alteracoes:          build.alteracoes
  };

  var campo = (_tipo === 'eda') ? 'dbEDA' : 'dbColono';
  var update = {
    atualizadoEm: firebase.firestore.FieldValue.serverTimestamp(),
    importadorConfig: { tolerancia: _tolerancia, pesoConceito: _pesoConceito }
  };
  update[campo] = build.novoDb;

  // Batch atômico: snapshot do import + atualização do banco
  var batch = _firestore.batch();
  batch.set(
    _firestore.collection('users').doc(_user.uid)
              .collection('imports').doc(ts),
    importDoc
  );
  batch.set(
    _firestore.collection('users').doc(_user.uid),
    update,
    { merge: true }
  );

  batch.commit()
    .then(function () {
      _db = build.novoDb;
      // Se o usuário é o admin, espelha em visitante/publico
      // (mesmo padrão dos apps geradores).
      if (_user.email === 'ekmogawa@gmail.com') {
        var pub = {};
        pub[campo] = build.novoDb;
        return _firestore.collection('visitante').doc('publico')
          .set(pub, { merge: true })
          .catch(function (e) { console.warn('[visitante sync]', e); });
      }
    })
    .then(function () {
      mostrarSucessoAplicacao(build, ts);
      renderizarResumoBanco(_db);
      _propostas.forEach(function (p) {
        if (p.status === 'aceita' || p.status === 'editada') {
          p.status = 'aplicada';
        }
      });
      carregarHistorico();
    })
    .catch(function (err) {
      console.error('[gravarTudo]', err);
      alert('Falha ao gravar: ' + err.message +
            '\n\nNenhuma alteração foi aplicada (gravação atômica).');
      btnAplicar.disabled = false;
      btnAplicar.textContent = 'Aplicar alterações no Firebase';
    });
}

// ============================================================
// Fase 7 — Histórico de imports + reversão
// ============================================================

function carregarHistorico() {
  if (!_user || !_firestore) return;
  var lista = document.getElementById('lista-historico');
  var card  = document.getElementById('card-historico');
  lista.innerHTML = '<div class="msg info">Carregando…</div>';

  // Sem composite index: ordena por realizadoEm desc no Firestore,
  // pega 30 mais recentes, depois filtra client-side por tipo e
  // limita a 10. (Composite index seria where+orderBy, evitamos.)
  _firestore.collection('users').doc(_user.uid)
    .collection('imports')
    .orderBy('realizadoEm', 'desc')
    .limit(30)
    .get()
    .then(function (snap) {
      var imports = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        if (d.tipo === _tipo) imports.push({ id: doc.id, dados: d });
      });
      imports = imports.slice(0, 10);
      renderizarHistorico(imports);
      // Mostra/esconde card conforme houver imports
      if (imports.length === 0) card.classList.add('hidden');
      else                       card.classList.remove('hidden');
    })
    .catch(function (err) {
      lista.innerHTML =
        '<div class="msg erro">Erro ao carregar histórico: ' +
        escaparHtml(err.message) + '</div>';
      card.classList.remove('hidden');
    });
}

function renderizarHistorico(imports) {
  var lista = document.getElementById('lista-historico');
  if (!imports.length) {
    lista.innerHTML = '<div class="proposta-vazia">Nenhum import realizado ainda.</div>';
    return;
  }

  var html = '';
  imports.forEach(function (entry) {
    var d = entry.dados;
    var revertido = !!d.revertidoEm;
    var origem    = d.origem || 'import';
    var ehRestore = (origem === 'backup-restore');

    var qAtual = (d.alteracoes || []).filter(function (a) {
      return a.tipo === 'atualizacao';
    }).length;
    var qNovos = (d.alteracoes || []).filter(function (a) {
      return a.tipo === 'novo';
    }).length;
    var nArquivos = (d.arquivosProcessados || []).length;

    // Cabeçalho meta varia por origem
    var metaHtml = ehRestore
      ? '<span class="import-meta">· restauração do <code>' +
          escaparHtml(d.slotRestaurado || '?') + '</code></span>'
      : '<span class="import-meta">· ' + nArquivos + ' arquivo(s)' +
          ' · tolerância ' + (d.toleranciaUsada != null ? d.toleranciaUsada : '?') +
          ' · peso ' + (d.pesoConceitoUsado != null ? Number(d.pesoConceitoUsado).toFixed(2) : '?') +
        '</span>';

    // Resumo varia por origem
    var resumoHtml = ehRestore
      ? '<div class="import-resumo">Banco substituído pelo snapshot do slot ' +
          escaparHtml(d.slotRestaurado || '?') + '.</div>'
      : '<div class="import-resumo">' +
          qAtual + ' atualização(ões) · ' + qNovos + ' novo(s) item(s)' +
        '</div>';

    var detalhesHtml = '';
    if (!ehRestore && d.alteracoes && d.alteracoes.length) {
      detalhesHtml = '<details class="import-detalhes"><summary>Ver alterações</summary><ul>';
      d.alteracoes.forEach(function (a) {
        if (a.tipo === 'atualizacao') {
          detalhesHtml +=
            '<li class="alt-update">' +
              '<strong>[' + escaparHtml(a.secao) + '] ' + escaparHtml(a.nome) + '</strong> · atualização' +
            '</li>';
        } else {
          detalhesHtml +=
            '<li class="alt-novo">' +
              '<strong>[' + escaparHtml(a.secao) + '] ' + escaparHtml(a.nome) + '</strong> · novo item' +
            '</li>';
        }
      });
      detalhesHtml += '</ul></details>';
    }

    var rotuloAcao = revertido
      ? 'Já revertido'
      : (ehRestore ? 'Reverter este restore' : 'Reverter este import');

    html +=
      '<div class="import-item' + (revertido ? ' revertido' : '') + '" ' +
            'data-id="' + escaparHtml(entry.id) + '">' +
        '<div class="import-cabecalho">' +
          '<span class="import-data">' + escaparHtml(formatarData(d.realizadoEm)) + '</span>' +
          metaHtml +
          (revertido
            ? '<span class="import-revertido-badge">' +
                'revertido em ' + escaparHtml(formatarData(d.revertidoEm)) +
              '</span>'
            : '') +
        '</div>' +
        resumoHtml +
        detalhesHtml +
        '<div class="import-acoes">' +
          '<button class="reverter" type="button"' +
            (revertido ? ' disabled' : '') + '>' +
            rotuloAcao +
          '</button>' +
        '</div>' +
      '</div>';
  });

  lista.innerHTML = html;

  // Wire dos botões reverter
  lista.querySelectorAll('.import-item button.reverter').forEach(function (btn) {
    if (btn.disabled) return;
    var item = btn.closest('.import-item');
    var id = item.dataset.id;
    btn.addEventListener('click', function () {
      handlerReverterImport(id);
    });
  });
}

function handlerReverterImport(importId) {
  var ref = _firestore.collection('users').doc(_user.uid)
                      .collection('imports').doc(importId);
  ref.get().then(function (doc) {
    if (!doc.exists) {
      alert('Import não encontrado.');
      return;
    }
    var d = doc.data();
    if (d.revertidoEm) {
      alert('Este import já foi revertido.');
      return;
    }
    if (!d.dbAnterior) {
      alert('Este import não tem dbAnterior salvo — impossível reverter.');
      return;
    }

    var qAtual = (d.alteracoes || []).filter(function (a) {
      return a.tipo === 'atualizacao';
    }).length;
    var qNovos = (d.alteracoes || []).filter(function (a) {
      return a.tipo === 'novo';
    }).length;
    var rotuloTipo = (_tipo === 'eda') ? 'EDA' : 'Colonoscopia';

    var html =
      '<p>Você está prestes a <strong>reverter</strong> o import de ' +
        escaparHtml(formatarData(d.realizadoEm)) + ' no banco da especialidade ' +
        '<strong>' + escaparHtml(rotuloTipo) + '</strong>.</p>' +
      '<ul class="resumo-mudancas">' +
        '<li>Desfaz <strong>' + qAtual + '</strong> atualização(ões)</li>' +
        '<li>Remove <strong>' + qNovos + '</strong> item(s) novo(s) criado(s) por este import</li>' +
      '</ul>' +
      '<p style="font-size:12px;color:#742a2a;">' +
        'O banco ativo será sobrescrito pelo <code>dbAnterior</code> deste import. ' +
        'Mudanças feitas em outros imports posteriores também serão DESFEITAS.' +
      '</p>';

    abrirModal('Reverter import', html, function () {
      // Confirmação dupla — segundo modal pede aceite final
      var html2 =
        '<p style="font-weight:600;color:#c53030;">Esta operação é destrutiva.</p>' +
        '<p>Deseja prosseguir com a reversão?</p>';
      abrirModal('Confirmação dupla', html2, function () {
        executarReversao(importId, d);
      });
    });
  })
  .catch(function (err) {
    alert('Falha ao ler import: ' + err.message);
  });
}

function executarReversao(importId, dadosImport) {
  // Sanity check: dbAnterior precisa ser objeto não-vazio com ao menos uma seção array.
  var anterior = dadosImport && dadosImport.dbAnterior;
  if (!anterior || typeof anterior !== 'object' ||
      !Object.keys(anterior).some(function (k) { return Array.isArray(anterior[k]); })) {
    alert('Reversão abortada: dbAnterior do import parece inválido.\n\n' +
          'Nenhuma alteração foi feita.');
    return;
  }

  // Lock para evitar duplo-click durante a operação.
  var botoesReverter = document.querySelectorAll('#card-historico button.reverter');
  botoesReverter.forEach(function (b) { b.disabled = true; });

  var campo = (dadosImport.tipo === 'eda') ? 'dbEDA' : 'dbColono';

  var batch = _firestore.batch();
  var update = {
    atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
  };
  update[campo] = anterior;
  batch.set(
    _firestore.collection('users').doc(_user.uid),
    update,
    { merge: true }
  );
  batch.update(
    _firestore.collection('users').doc(_user.uid)
              .collection('imports').doc(importId),
    { revertidoEm: firebase.firestore.FieldValue.serverTimestamp() }
  );

  batch.commit()
    .then(function () {
      _db = anterior;
      // Limpa propostas em memória — elas referenciam o _db
      // pré-reversão e podem aplicar mudanças incorretas se reusadas.
      _propostas = [];
      var cardRev = document.getElementById('card-revisao');
      if (cardRev) cardRev.classList.add('hidden');

      // Espelha em visitante/publico se admin
      if (_user.email === 'ekmogawa@gmail.com') {
        var pub = {};
        pub[campo] = anterior;
        return _firestore.collection('visitante').doc('publico')
          .set(pub, { merge: true })
          .catch(function (e) { console.warn('[visitante sync revert]', e); });
      }
    })
    .then(function () {
      renderizarResumoBanco(_db);
      alert('✓ Reversão concluída. O banco voltou ao estado anterior a este import.');
      carregarHistorico();
    })
    .catch(function (err) {
      alert('Falha na reversão: ' + err.message);
      // Reabilita botões — exceto os já-revertidos que ficam disabled
      // por estado, naturalmente reaplicado via carregarHistorico.
      carregarHistorico();
    });
}

function mostrarSucessoAplicacao(build, ts) {
  var qAtual = build.alteracoes.filter(function (a) { return a.tipo === 'atualizacao'; }).length;
  var qNovos = build.alteracoes.filter(function (a) { return a.tipo === 'novo'; }).length;

  var urlGerador = (_tipo === 'eda')
    ? 'https://ekmogawa.github.io/Gerar-laudo-EDA/'
    : 'https://ekmogawa.github.io/Gerar-Laudo-Colono/';

  var painel = document.createElement('div');
  painel.className = 'painel-sucesso';
  painel.innerHTML =
    '<h3>✓ Alterações aplicadas com sucesso</h3>' +
    '<p>' + qAtual + ' item(s) atualizado(s) · ' + qNovos + ' novo(s) item(s) criado(s).</p>' +
    '<p style="font-size:12px;color:#22543d;">Snapshot do banco anterior salvo em ' +
    '<code>users/' + escaparHtml(_user.uid) + '/imports/' + escaparHtml(ts) + '</code> ' +
    '(reversível pela aba Histórico, Fase 7).</p>' +
    '<div class="acoes-pos">' +
      '<a class="acao" style="text-decoration:none;display:inline-block;" ' +
         'href="' + urlGerador + '" target="_blank" rel="noopener">' +
         'Abrir gerador (' + (_tipo === 'eda' ? 'EDA' : 'Colono') + ')</a>' +
      '<button class="acao secundaria" id="btn-novo-import" type="button">' +
         'Fazer outro import</button>' +
    '</div>';

  // Insere no topo do card-revisao e desabilita ações
  var card = document.getElementById('card-revisao');
  // Remove painel anterior se houver (caso usuário fez 2 imports na mesma sessão)
  var antigo = card.querySelector('.painel-sucesso');
  if (antigo) antigo.remove();
  card.insertBefore(painel, card.firstChild.nextSibling);

  // Desabilita botões da revisão
  document.querySelectorAll('#card-revisao .filtro-btn, #card-revisao .acoes-massa button')
    .forEach(function (b) { b.disabled = true; });
  var btnAplicar = document.getElementById('btn-aplicar');
  btnAplicar.disabled = true;
  btnAplicar.textContent = 'Aplicado';

  document.getElementById('btn-novo-import').addEventListener('click', function () {
    limparArquivos();
    painel.remove();
    document.querySelectorAll('#card-revisao .filtro-btn, #card-revisao .acoes-massa button')
      .forEach(function (b) { b.disabled = false; });
    btnAplicar.textContent = 'Aplicar alterações no Firebase';
    btnAplicar.disabled = true;
    // Scroll para o card de upload
    document.getElementById('zona-upload').scrollIntoView({ behavior: 'smooth' });
  });
}

// ============================================================
// Fase 4 — Slider de tolerância (calibração ao vivo)
// ============================================================

// Reaplica classificação a todas as linhas do tabela-scores e
// recalcula contadores ao vivo. Não re-roda matching (apenas
// reclassifica scores cacheados).
function aplicarTolerancia(tolerancia) {
  _tolerancia = tolerancia;
  if (_config) _config.tolerancia = tolerancia;

  var lim = Matching.derivaLimiares(tolerancia);

  // Itera linhas do tabela-scores (usa data-final cacheado)
  var linhas = document.querySelectorAll('#tabela-scores tbody tr');
  linhas.forEach(function (tr) {
    var raw = tr.getAttribute('data-final');
    var fin = (raw === '' || raw === null) ? null : Number(raw);
    var classe = Matching.classificarScore(fin, tolerancia);
    // Limpa classes anteriores e aplica nova
    tr.classList.remove('linha-match', 'linha-atualizacao',
                        'linha-variante', 'linha-naoEncontrado', 'muted');
    tr.classList.add('linha-' + classe);
    if (classe === 'naoEncontrado') tr.classList.add('muted');
    // Atualiza badge na coluna Status
    var bcs = tr.querySelector('.badge-cls');
    if (bcs) {
      bcs.className = 'badge-cls ' + classe;
      bcs.textContent = rotuloClassificacao(classe);
    }
  });

  recalcularContadores(tolerancia);

  // Tela de revisão usa as mesmas classificações; re-renderiza para
  // que badges e filtros reflitam a nova tolerância. Pula re-render
  // se houver proposta em edição (preserva foco e cursor da textarea).
  // Os listeners 'input' garantem que o texto já foi salvo em estado
  // — quando o usuário sair do modo edição, o re-render seguinte usa
  // os valores corretos.
  var emEdicao = _propostas.some(function (p) { return p.status === 'editando'; });
  if (_propostas.length && !emEdicao) renderizarListaPropostas();
}

function rotuloClassificacao(classe) {
  switch (classe) {
    case 'match':         return 'match';
    case 'atualizacao':   return 'atualizar';
    case 'variante':      return 'variante';
    case 'naoEncontrado': return 'não encontrado';
    default:              return classe;
  }
}

// Conta itens (não rows) por classificação. Para cada item do banco,
// pega o MAIOR final entre todos os arquivos e classifica esse maior.
// Itens novos são contados separadamente via consensoNovos.
function recalcularContadores(tolerancia) {
  if (!_matching) return;

  var melhorPorItem = {};  // (secao + ':' + key) -> { item, maxFinal }

  _matching.porArquivo.forEach(function (pa) {
    (pa.secoes || []).forEach(function (sec) {
      (sec.matchesPorItem || []).forEach(function (mpi) {
        if (!mpi.melhor) return;
        var key = sec.nome + ':' + (mpi.item.id || mpi.item.nome || '?');
        var atual = melhorPorItem[key];
        if (!atual || mpi.melhor.score.final > atual.maxFinal) {
          melhorPorItem[key] = {
            item:     mpi.item,
            maxFinal: mpi.melhor.score.final
          };
        }
      });
    });
  });

  var contadores = { match: 0, atualizacao: 0, variante: 0, naoEncontrado: 0 };
  Object.keys(melhorPorItem).forEach(function (k) {
    var c = Matching.classificarScore(melhorPorItem[k].maxFinal, tolerancia);
    contadores[c]++;
  });

  // Itens novos: total de grupos em consensoNovos
  var totalNovos = 0;
  Object.keys(_matching.consensoNovos || {}).forEach(function (s) {
    totalNovos += _matching.consensoNovos[s].length;
  });

  var setarContador = function (classe, valor) {
    var el = document.querySelector('.contador.' + classe + ' b');
    if (el) el.textContent = String(valor);
  };
  setarContador('match',         contadores.match);
  setarContador('atualizacao',   contadores.atualizacao);
  setarContador('variante',      contadores.variante);
  setarContador('naoEncontrado', contadores.naoEncontrado);
  setarContador('novo',          totalNovos);
}

// Wiring dos sliders. Chamado uma vez no DOMContentLoaded.
function configurarSliders() {
  var slT = document.getElementById('slider-tolerancia');
  var vT  = document.getElementById('valor-tolerancia');
  var slP = document.getElementById('slider-peso');
  var vP  = document.getElementById('valor-peso');

  if (slT) {
    slT.addEventListener('input', function () {
      var t = Number(slT.value);
      vT.textContent = String(t);
      aplicarTolerancia(t);
    });
  }

  if (slP) {
    var debounce = null;
    slP.addEventListener('input', function () {
      var p = Number(slP.value) / 100;
      vP.textContent = p.toFixed(2);
      _pesoConceito = p;
      if (_config) _config.pesoConceito = p;
      // Recalcula matching só quando o usuário estabiliza (debounce 250ms)
      // — é caro re-rodar a cada pixel do slide.
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        if (_matching) rodarMatching();
      }, 250);
    });
  }
}

// Tabela: Item do banco × melhor trecho candidato em cada arquivo.
// Dentro de cada (arquivo, seção), os itens são ordenados por score final
// descendente — winners primeiro, irrelevantes ao final. Linhas com
// score zero ficam visualmente mudadas (classe `.muted`).
function renderizarTabelaScores() {
  var html =
    '<table>' +
      '<thead><tr>' +
        '<th>Arquivo</th>' +
        '<th>Seção</th>' +
        '<th>Item do banco</th>' +
        '<th>Trecho candidato (janela vencedora)</th>' +
        '<th class="score">Conc</th>' +
        '<th class="score">Sup</th>' +
        '<th class="score">Final</th>' +
        '<th>Status</th>' +
      '</tr></thead><tbody>';

  _matching.porArquivo.forEach(function (pa) {
    (pa.secoes || []).forEach(function (sec) {
      // Ordena: winners primeiro, score 0 por último.
      var ordenados = (sec.matchesPorItem || []).slice().sort(function (a, b) {
        var fa = a.melhor ? a.melhor.score.final : -1;
        var fb = b.melhor ? b.melhor.score.final : -1;
        return fb - fa;
      });

      ordenados.forEach(function (mpi) {
        var nomeItem = mpi.item.nome || mpi.item.id || '?';
        var trecho   = mpi.melhor ? mpi.melhor.janela.texto : '<em>(sem janela)</em>';
        var conc = mpi.melhor ? mpi.melhor.score.conceito   : null;
        var sup  = mpi.melhor ? mpi.melhor.score.superficie : null;
        var fin  = mpi.melhor ? mpi.melhor.score.final      : null;

        // data-final permite reclassificação em tempo real sem re-render
        var dataFinal = (fin === null) ? '' : String(fin);

        var tooltipBanco = mpi.item.valor
          ? ' title="' + escaparHtml(String(mpi.item.valor).slice(0, 240)) + '"'
          : '';

        html +=
          '<tr data-final="' + dataFinal + '">' +
            '<td>' + escaparHtml(pa.arquivo) + '</td>' +
            '<td>' + escaparHtml(sec.nome) + '</td>' +
            '<td class="item-banco"' + tooltipBanco + '>' + escaparHtml(nomeItem) + '</td>' +
            '<td class="clausula">' + escaparHtml(trecho) + '</td>' +
            '<td class="score ' + classeScore(conc) + '">' + fmt(conc) + '</td>' +
            '<td class="score ' + classeScore(sup)  + '">' + fmt(sup)  + '</td>' +
            '<td class="score ' + classeScore(fin)  + '">' + fmt(fin)  + '</td>' +
            '<td><span class="badge-cls">—</span></td>' +
          '</tr>';
      });
    });
  });
  html += '</tbody></table>';
  document.getElementById('tabela-scores').innerHTML = html;
}

// Tabela: candidatos a NOVO item (trechos não cobertos), agregados por seção
function renderizarTabelaNovos() {
  var html = '';
  var temConteudo = false;
  Object.keys(_matching.consensoNovos || {}).forEach(function (secao) {
    var grupos = _matching.consensoNovos[secao];
    if (!grupos.length) return;
    temConteudo = true;
    html += '<h4 style="margin:12px 8px 4px 8px;color:#c05621;text-transform:capitalize;">' +
            escaparHtml(secao) + '</h4>';
    html +=
      '<table>' +
        '<thead><tr>' +
          '<th>Trecho representativo</th>' +
          '<th>Frequência</th>' +
          '<th>Variantes (#cands)</th>' +
        '</tr></thead><tbody>';

    var totalArquivos = _matching.porArquivo.length;
    grupos.forEach(function (g) {
      var ehBaixa = totalArquivos > 0 && (g.frequenciaArquivos / totalArquivos) < 0.30;
      html +=
        '<tr>' +
          '<td class="clausula">' + escaparHtml(g.representante) + '</td>' +
          '<td><span class="freq-badge' + (ehBaixa ? ' baixa' : '') + '">' +
            g.frequenciaArquivos + ' de ' + totalArquivos + '</span></td>' +
          '<td>' + g.totalCandidatos + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  });

  if (!temConteudo) {
    html = '<p style="padding:12px;color:#888;font-size:12px;">' +
           'Nenhum trecho ficou sem cobertura — todos os achados dos arquivos ' +
           'casaram com itens existentes do banco. Ajuste o threshold de ' +
           'cobertura (0.50 default) para flexibilizar.</p>';
  }

  document.getElementById('tabela-novos').innerHTML = html;
}

function renderizarTabelaConsenso() {
  var html = '';
  var temConteudo = false;

  Object.keys(_matching.consenso).forEach(function (secao) {
    var lista = _matching.consenso[secao];
    if (!lista.length) return;
    temConteudo = true;
    html += '<h4 style="margin:12px 8px 4px 8px;color:#2c5282;text-transform:capitalize;">' +
            escaparHtml(secao) + '</h4>';
    html +=
      '<table>' +
        '<thead><tr>' +
          '<th>Item</th>' +
          '<th>Versão consenso</th>' +
          '<th>Frequência</th>' +
          '<th>Variantes</th>' +
        '</tr></thead><tbody>';

    lista.forEach(function (entry) {
      var totalArquivos = _matching.porArquivo.length;
      var freq = entry.frequenciaArquivos;
      var ehBaixa = totalArquivos > 0 && (freq / totalArquivos) < 0.30;
      var nomeItem = (entry.item && (entry.item.nome || entry.item.id)) || '?';
      // representante agora é STRING direto (texto da janela representativa)
      var consensoTexto = entry.grupoConsenso && entry.grupoConsenso.representante
        ? entry.grupoConsenso.representante : '—';

      html +=
        '<tr>' +
          '<td class="item-banco">' + escaparHtml(nomeItem) + '</td>' +
          '<td class="clausula">' + escaparHtml(consensoTexto) + '</td>' +
          '<td><span class="freq-badge' + (ehBaixa ? ' baixa' : '') + '">' +
            freq + ' de ' + totalArquivos + '</span></td>' +
          '<td>' + entry.variantes.length + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  });

  if (!temConteudo) {
    html = '<p style="padding:12px;color:#888;font-size:12px;">' +
           'Nenhum item do banco recebeu cláusulas acima do limiar de match (0.65). ' +
           'Ajuste o limiar ou adicione mais laudos.</p>';
  }

  document.getElementById('tabela-consenso').innerHTML = html;
}

function renderizarTabelaPerfil() {
  if (!_matching.perfil) return;
  var html = '';
  var temConteudo = false;
  Object.keys(_matching.perfil).forEach(function (secao) {
    var lista = _matching.perfil[secao];
    if (!lista || !lista.length) return;
    temConteudo = true;
    html += '<h4 style="margin:12px 8px 4px 8px;color:#2c5282;text-transform:capitalize;">' +
            escaparHtml(secao) + '</h4>';
    html +=
      '<table>' +
        '<thead><tr>' +
          '<th>Item</th>' +
          '<th>Termos característicos (top 8 + âncoras)</th>' +
        '</tr></thead><tbody>';
    lista.forEach(function (p) {
      var nome = (p.item && (p.item.nome || p.item.id)) || '?';
      var tags = p.termosCaracteristicos.map(function (c) {
        var classe = c.ancora ? 'tag-termo ancora' : 'tag-termo';
        var titulo = 'tf=' + c.tf + ', idf=' + c.idf.toFixed(2) +
                     ', score=' + c.score.toFixed(2);
        return '<span class="' + classe + '" title="' + titulo + '">' +
               escaparHtml(c.termo) + '</span>';
      }).join('');
      html +=
        '<tr>' +
          '<td class="item-banco">' + escaparHtml(nome) + '</td>' +
          '<td><div class="tags-termos">' + tags + '</div></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  });
  if (!temConteudo) {
    html = '<p style="padding:12px;color:#888;font-size:12px;">' +
           'Banco do usuário vazio.</p>';
  }
  document.getElementById('tabela-perfil').innerHTML = html;
}

// Re-renderiza a lista mantendo os badges de status (após processamento)
function renderizarListaArquivosPreservandoStatus() {
  var ul = document.getElementById('lista-arquivos');
  var statusAtuais = {};
  ul.querySelectorAll('li').forEach(function (li) {
    var span = li.querySelector('.status');
    statusAtuais[li.dataset.idx] = { className: span.className, text: span.textContent };
  });
  renderizarListaArquivos();
  // Restaura status visual
  Object.keys(statusAtuais).forEach(function (idx) {
    var li = ul.querySelector('li[data-idx="' + idx + '"]');
    if (!li) return;
    var span = li.querySelector('.status');
    span.className = statusAtuais[idx].className;
    span.textContent = statusAtuais[idx].text;
  });
}

function global_ParserWord() {
  if (typeof ParserWord === 'undefined') {
    alert('parser_word.js ou mammoth.js não carregaram. Verifique o console.');
    return false;
  }
  return true;
}

// ------------------------------------------------------------
// Renderização da árvore: arquivo -> seção -> cláusulas
// ------------------------------------------------------------
function renderizarArvore() {
  var card = document.getElementById('card-resultado');
  var resumo = document.getElementById('resumo-resultado');
  var arvore = document.getElementById('arvore-resultado');

  card.classList.remove('hidden');

  var totalArquivos = _resultados.length;
  var arquivosOk = _resultados.filter(function (r) { return !r.erro; }).length;
  var totalSecoes = 0;
  var totalClausulas = 0;
  var totalImagens = 0;
  var totalInferidas = 0;
  _resultados.forEach(function (r) {
    if (r.erro) return;
    totalSecoes += r.secoes.length;
    r.secoes.forEach(function (s) { totalClausulas += s.clausulas.length; });
    totalImagens += (r.imagensDescartadas || 0);
    totalInferidas += (r.sentencasInferidas || 0);
  });

  var avisos = '';
  if (totalInferidas) {
    avisos += ' · <span style="color:#3182ce;" title="Sentenças sem cabeçalho de seção, atribuídas pela presença de âncoras anatômicas">' +
              totalInferidas + ' sentença(s) inferida(s) por âncoras' +
              '</span>';
  }
  if (totalImagens) {
    avisos += ' · <span style="color:#b7791f;">' + totalImagens +
              ' imagem(ns) descartada(s) (apenas texto é processado)</span>';
  }

  resumo.innerHTML =
    '<p>' + arquivosOk + ' de ' + totalArquivos + ' arquivos processados · ' +
    totalSecoes + ' seções detectadas · ' +
    totalClausulas + ' cláusulas extraídas' + avisos + '.</p>';

  var html = '';
  // Para facilitar inspeção, abre o primeiro arquivo por padrão
  var jaAbriu = false;
  _resultados.forEach(function (r) {
    if (r.erro) {
      html += '<details class="arquivo" open>' +
                '<summary>' + escaparHtml(r.arquivo) + '</summary>' +
                '<div class="erro-arquivo">' + escaparHtml(r.erro) + '</div>' +
              '</details>';
      jaAbriu = true;
      return;
    }
    var attrOpen = jaAbriu ? '' : ' open';
    jaAbriu = true;
    html += '<details class="arquivo"' + attrOpen + '>' +
              '<summary>' + escaparHtml(r.arquivo) +
                ' <span style="color:#888;font-weight:normal;">(' +
                r.secoes.length + ' seções, ' +
                r.secoes.reduce(function (a, s) { return a + s.clausulas.length; }, 0) +
                ' cláusulas)</span></summary>';

    r.secoes.forEach(function (s) {
      var vazia = s.clausulas.length === 0;
      // Rótulo extra: original do Word entre aspas, ou "(inferido)"/"(implícito)"
      // sem aspas porque já vem entre parênteses.
      var labelExtra = '';
      if (s.rotuloOriginal) {
        if (s.rotuloOriginal.charAt(0) === '(') {
          labelExtra = escaparHtml(s.rotuloOriginal);
        } else if (s.rotuloOriginal.toLowerCase() !== s.nome) {
          labelExtra = '("' + escaparHtml(s.rotuloOriginal) + '")';
        }
      }
      html += '<details class="secao' + (vazia ? ' vazia' : '') + '">' +
                '<summary>' + escaparHtml(s.nome) +
                  ' <span class="rotulo-original">' + labelExtra + '</span>' +
                  ' <span style="color:#888;font-weight:normal;">· ' +
                    s.clausulas.length + ' cláus</span>' +
                '</summary>';
      if (s.clausulas.length) {
        html += '<ul class="clausulas">';
        s.clausulas.forEach(function (c) {
          html += '<li>' + escaparHtml(c.texto) + '</li>';
        });
        html += '</ul>';
      }
      html += '</details>';
    });

    // Texto que ficou fora de qualquer seção
    if (r.orfaos && r.orfaos.clausulas && r.orfaos.clausulas.length) {
      html += '<details class="orfaos"><summary>(sem seção identificada) · ' +
                r.orfaos.clausulas.length + ' cláus</summary>' +
              '<ul class="clausulas">';
      r.orfaos.clausulas.forEach(function (c) {
        html += '<li>' + escaparHtml(c.texto) + '</li>';
      });
      html += '</ul></details>';
    }

    html += '</details>';
  });

  arvore.innerHTML = html;
}

// ============================================================
// Wiring DOM
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  inicializarFirebase();
  configurarUpload();
  configurarSliders();
  configurarFiltrosRevisao();

  var btnLogout = document.getElementById('btn-logout');
  if (btnLogout) btnLogout.addEventListener('click', fazerLogout);
});
