// ============================================================
// Gerar-Laudo-Importador — parser_word.js
// Conversão .docx -> texto, detecção de seções e decomposição
// em cláusulas (Camada 1 do pipeline conceitual, §6.1 e §6.2 do
// PLANO).
//
// Depende de mammoth.js carregado via CDN (window.mammoth).
// ============================================================

(function (global) {
  'use strict';

  // ----------------------------------------------------------
  // Mapeamento "nome no Word" -> "chave canônica do banco".
  // Inclui formas compostas comuns ("Indicação clínica",
  // "Preparo do cólon") para casamento direto sem fallback.
  // ----------------------------------------------------------
  var SINONIMOS = {
    eda: {
      'equipamento':            'equipamento',
      'aparelho':               'equipamento',
      'sedacao':                'sedacao',
      'sedacao e medicacao':    'sedacao',
      'medicacao':              'sedacao',
      'esofago':                'esofago',
      'estomago':               'estomago',
      'duodeno':                'duodeno',
      'jejuno':                 'jejuno',
      'conclusao':              'conclusao',
      'conclusoes':             'conclusao',
      'achados':                'outros',
      'observacoes':            'outros',
      'observacao':             'outros',
      'outros':                 'outros'
    },
    colono: {
      'indicacao':              'indicacao',
      'indicacoes':             'indicacao',
      'indicacao clinica':      'indicacao',
      'motivo do exame':        'indicacao',
      'equipamento':            'equipamento',
      'aparelho':               'equipamento',
      'sedacao':                'sedacao',
      'sedacao e medicacao':    'sedacao',
      'medicacao':              'sedacao',
      'preparo':                'preparo',
      'preparo do colon':       'preparo',
      'preparo intestinal':     'preparo',
      'exame':                  'exame',
      'achados':                'exame',
      'descricao do exame':     'exame',
      'colonoscopia':           'exame',
      'conclusao':              'conclusao',
      'conclusoes':             'conclusao',
      'observacoes':            'obs',
      'observacao':             'obs',
      'obs':                    'obs',
      'outros':                 'outros'
    }
  };

  // ----------------------------------------------------------
  // Termos-âncora por seção (lista curada).
  //
  // Usados para classificar parágrafos órfãos (sem cabeçalho
  // de seção explícito): para cada sentença órfã, conta quantas
  // âncoras de cada seção aparecem; a seção com mais matches
  // recebe a sentença. Sem matches => permanece órfã (ou cai no
  // fallback colono->exame).
  //
  // Termos já normalizados (minúsculas, sem acento). Busca por
  // substring — mantenha específicos para evitar falsos positivos.
  // ----------------------------------------------------------
  var ANCORAS = {
    eda: {
      equipamento: ['equipamento', 'gif-', 'eg-', 'olympus', 'fujifilm', 'aparelho',
                    'magnificacao', 'cromoscopia digital', 'imagem hd'],
      sedacao:     ['sedacao', 'anestesia', 'anestesista', 'fentanil', 'midazolam',
                    'propofol', 'intensivista', 'anestesia geral'],
      esofago:     ['esofago', 'esofagite', 'esofagica', 'teg ', 'transicao esofagogastrica',
                    'pincamento diafragmatico', 'hernia hiatal', 'barrett', 'mucosa esofagica'],
      estomago:    ['estomago', 'gastrica', 'gastrico', 'antro', 'corpo gastrico',
                    'fundo gastrico', 'incisura', 'piloro', 'gastrite', 'metaplasia intestinal',
                    'helicobacter', 'h. pylori', 'cardia'],
      duodeno:     ['duodeno', 'duodenal', 'bulbo', 'papila duodenal', 'segunda porcao',
                    'joanete'],
      jejuno:      ['jejuno', 'jejunal'],
      conclusao:   ['conclusao', 'diagnostico', 'em sintese', 'sintese', 'em conclusao'],
      outros:      []
    },
    colono: {
      indicacao:   ['indicacao', 'indicacoes', 'motivo do exame', 'queixa', 'rastreio',
                    'rastreamento', 'screening', 'historia familiar'],
      // 'colonoscopio' fica de fora — aparece no corpo do laudo
      // (introdução do colonoscópio até X) e geraria falso positivo
      // contra anatomia. 'cf-' / 'olympus' / 'fujifilm' são específicos.
      equipamento: ['cf-', 'cf ', 'olympus', 'fujifilm', 'aparelho'],
      sedacao:     ['sedacao', 'anestesia', 'anestesista', 'fentanil', 'midazolam',
                    'propofol', 'intensivista', 'anestesia geral'],
      preparo:     ['preparo', 'boston', 'fleet', 'manitol', 'picoprep', 'lavagem',
                    'preparo intestinal'],
      exame:       ['ceco', 'valvula ileocecal', 'ileo terminal', 'colon ascendente',
                    'colon transverso', 'colon descendente', 'colon sigmoide', 'sigmoide',
                    'reto', 'mucosa colorretal', 'anastomose colorretal', 'divertic',
                    'toque retal', 'canal anal'],
      conclusao:   ['conclusao', 'diagnostico', 'em sintese', 'sintese', 'em conclusao'],
      obs:         ['observacao', 'observacoes', 'obs:'],
      outros:      []
    }
  };

  // ----------------------------------------------------------
  // Normaliza string para comparação: sem acento, minúsculas,
  // sem pontuação final e com espaços colapsados.
  // ̀-ͯ = bloco "Combining Diacritical Marks".
  // ----------------------------------------------------------
  var REGEX_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

  function normalizar(s) {
    if (!s) return '';
    return String(s)
      .normalize('NFD').replace(REGEX_DIACRITICOS, '')
      .toLowerCase()
      .replace(/[:.;,!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ----------------------------------------------------------
  // Casa texto com a lista de sinônimos do tipo. Tenta:
  //   1) string normalizada inteira
  //   2) string até o primeiro ":" (caso usuário tenha incluído)
  //   3) primeira palavra (handle de cabeçalho composto: "Indicação
  //      clínica" → "indicacao")
  // Retorna chave canônica ou null.
  // ----------------------------------------------------------
  function casarSecao(texto, tipo) {
    var sinonimos = SINONIMOS[tipo] || {};
    var norm = normalizar(texto);
    if (!norm) return null;
    if (sinonimos[norm]) return sinonimos[norm];

    var sCorte = norm.split(':')[0].trim();
    if (sCorte && sinonimos[sCorte]) return sinonimos[sCorte];

    var primeiraPalavra = sCorte.split(/\s+/)[0];
    if (primeiraPalavra && sinonimos[primeiraPalavra]) {
      return sinonimos[primeiraPalavra];
    }
    return null;
  }

  // ----------------------------------------------------------
  // Verifica se o `<strong>` é o primeiro elemento "significativo"
  // do parágrafo, ignorando whitespace mas NÃO ignorando texto
  // antes dele. Usado pela Regra 1 para evitar falso positivo em
  // parágrafos como `<p>Achados: <strong>Esôfago:</strong></p>`.
  // ----------------------------------------------------------
  function strongNoComeco(p, strongElem) {
    var n = p.firstChild;
    while (n && n !== strongElem) {
      if (n.nodeType === 3 /* text node */ && n.textContent.trim() !== '') {
        return false;
      }
      n = n.nextSibling;
    }
    return n === strongElem;
  }

  // ----------------------------------------------------------
  // Detecta cabeçalho de seção em um <p>/<h*> do mammoth.
  // §6.1 do PLANO, em ordem de confiabilidade.
  // ----------------------------------------------------------
  function detectarSecao(p, tipo) {
    var texto = (p.textContent || '').trim();
    if (!texto) return null;

    // Regra 1 — cabeçalho em <strong> NO INÍCIO do parágrafo
    var primeiroFilho = p.firstElementChild;
    if (primeiroFilho &&
        (primeiroFilho.tagName === 'STRONG' || primeiroFilho.tagName === 'B') &&
        strongNoComeco(p, primeiroFilho)) {
      var strongTxt = (primeiroFilho.textContent || '').trim();
      // Posição do strong dentro de texto. textContent inclui qualquer
      // whitespace antes do strong (já confirmamos não haver texto-letra),
      // então usamos indexOf como referência segura.
      var idxStrong = texto.indexOf(strongTxt);
      if (idxStrong !== -1) {
        var resto = texto.substring(idxStrong + strongTxt.length).replace(/^\s+/, '');
        var temColon = strongTxt.endsWith(':') || resto.startsWith(':');
        if (temColon) {
          var nomeStrong = strongTxt.replace(/:$/, '').trim();
          var canonico = casarSecao(nomeStrong, tipo);
          if (canonico) {
            return {
              nome: canonico,
              rotuloOriginal: nomeStrong,
              restoTexto: resto.replace(/^:/, '').trim()
            };
          }
        }
      }
    }

    // Regra 2 — termo conhecido + ":" no início
    var m = texto.match(/^([\wÀ-ÿ]+(?:\s+[\wÀ-ÿ]+){0,3})\s*:\s*(.*)$/);
    if (m) {
      var canonico2 = casarSecao(m[1], tipo);
      if (canonico2) {
        return { nome: canonico2, rotuloOriginal: m[1], restoTexto: (m[2] || '').trim() };
      }
    }

    // Regra 3 — linha curta isolada, capitalizada/maiúscula
    if (texto.length < 30) {
      var ehCabecalho = texto === texto.toUpperCase() ||
                        /^[A-ZÀ-Ý]/.test(texto);
      if (ehCabecalho) {
        var canonico3 = casarSecao(texto, tipo);
        if (canonico3) {
          return { nome: canonico3, rotuloOriginal: texto, restoTexto: '' };
        }
      }
    }

    return null;
  }

  // ----------------------------------------------------------
  // Quebra um texto em sentenças por ". ", "! ", "? ".
  // Trata <br> como fim de sentença (compatível com a seção
  // "exame" do colono, que vem com <br> no `valor` do banco).
  // ----------------------------------------------------------
  function quebrarSentencas(texto) {
    if (!texto) return [];
    var t = String(texto).replace(/<br\s*\/?>/gi, '. ');
    var sentencas = [];
    var atual = '';
    for (var i = 0; i < t.length; i++) {
      atual += t[i];
      if ((t[i] === '.' || t[i] === '!' || t[i] === '?') &&
          (i === t.length - 1 || /\s/.test(t[i + 1]))) {
        var s = atual.trim();
        if (s) sentencas.push(s);
        atual = '';
      }
    }
    if (atual.trim()) sentencas.push(atual.trim());
    return sentencas;
  }

  // ----------------------------------------------------------
  // Classifica uma sentença pela sobreposição de âncoras de cada
  // seção. Em empate, vence a primeira (ordem em ANCORAS).
  // Retorna { secao, score, ancorasEncontradas } ou null.
  // ----------------------------------------------------------
  function classificarSentenca(sentenca, tipo) {
    var ancoras = ANCORAS[tipo] || {};
    var norm = normalizar(sentenca);
    if (!norm) return null;

    var melhor = null;
    Object.keys(ancoras).forEach(function (secao) {
      var lista = ancoras[secao] || [];
      if (lista.length === 0) return;
      var matches = 0;
      var encontrados = [];
      lista.forEach(function (termo) {
        if (norm.indexOf(termo) !== -1) {
          matches++;
          encontrados.push(termo);
        }
      });
      if (matches > 0 && (!melhor || matches > melhor.score)) {
        melhor = { secao: secao, score: matches, ancorasEncontradas: encontrados };
      }
    });
    return melhor;
  }

  // ----------------------------------------------------------
  // Decompõe um parágrafo em cláusulas (§6.2). Descarta cláusulas
  // com menos de 3 palavras.
  // ----------------------------------------------------------
  function decomporClausulas(texto) {
    if (!texto) return [];
    var sentencas = quebrarSentencas(texto);
    var clausulas = [];
    sentencas.forEach(function (s) {
      var partes = s.split(/\s*,\s*|\s*;\s*|\s+e\s+|\s+ou\s+/i);
      partes.forEach(function (p) {
        var limpa = p.replace(/^[\s.!?]+|[\s.!?]+$/g, '').trim();
        if (!limpa) return;
        var palavras = limpa.split(/\s+/).filter(Boolean);
        if (palavras.length >= 3) {
          clausulas.push(limpa);
        }
      });
    });
    return clausulas;
  }

  // ----------------------------------------------------------
  // Helpers de texto plano -> HTML (.txt, .rtf, .doc)
  // ----------------------------------------------------------
  function escaparHtmlTexto(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Linhas em branco separam parágrafos; quebras simples viram <br>.
  function textoPlanoParaHtml(texto) {
    var paragrafos = String(texto || '').split(/\r?\n\s*\r?\n+/);
    return paragrafos.map(function (par) {
      var linhas = par.split(/\r?\n/)
        .map(function (l) { return escaparHtmlTexto(l.trim()); })
        .filter(function (l) { return l.length; });
      if (!linhas.length) return '';
      return '<p>' + linhas.join('<br>') + '</p>';
    }).filter(Boolean).join('');
  }

  // Despoja RTF de control words/escapes e devolve texto plano.
  // Cobertura suficiente para RTFs gerados pelo Word/LibreOffice;
  // tabelas/campos complexos podem perder formatação mas o texto
  // sai legível.
  function rtfParaTexto(rtf) {
    if (!rtf) return '';
    var s = String(rtf);
    // Remove grupos de metadados (font/color/style/info/etc.)
    s = s.replace(
      /\{\\\*?\\(?:fonttbl|colortbl|stylesheet|info|generator|listtable|listoverridetable|rsidtbl|datastore|themedata|latentstyles|filetbl|fldinst|pict|object|bin|header|footer|footnote|annotation|nonshppict)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi,
      ''
    );
    // \par / \line viram quebra; \tab vira tab
    s = s.replace(/\\par[d]?\b\s?/g, '\n');
    s = s.replace(/\\line\b\s?/g, '\n');
    s = s.replace(/\\tab\b\s?/g, '\t');
    // \'XX (CP1252)
    s = s.replace(/\\'([0-9a-fA-F]{2})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
    // \uNNNN (signed 16-bit Unicode)
    s = s.replace(/\\u(-?\d+)\??/g, function (_, n) {
      var code = parseInt(n, 10);
      if (code < 0) code += 65536;
      return String.fromCharCode(code);
    });
    // Sequências escapadas
    s = s.replace(/\\\\/g, '\\').replace(/\\\{/g, '{').replace(/\\\}/g, '}');
    // Control words restantes
    s = s.replace(/\\[a-zA-Z]+(-?\d+)?\s?/g, '');
    // Control symbols restantes
    s = s.replace(/\\[^a-zA-Z\\]/g, '');
    // Chaves de grupo
    s = s.replace(/[{}]/g, '');
    return s;
  }

  // Extração best-effort de .doc binário (Word 97+ CFB). Sem parser
  // de OLE/CFB, varremos o buffer por runs imprimíveis em UTF-16LE
  // (encoding interno do Word) e caímos para ASCII se UTF-16 não
  // render. Pode falhar em .doc protegido/criptografado ou Word 6/95.
  function extrairTextoDocBinario(buffer) {
    var bytes = new Uint8Array(buffer);
    var n = bytes.length;
    var minRun = 8;
    var trechos = [];
    var atual = '';

    // Pass UTF-16LE
    for (var i = 0; i + 1 < n; i += 2) {
      var lo = bytes[i], hi = bytes[i + 1];
      var imprimivel = (hi === 0x00 && ((lo >= 0x20 && lo <= 0x7E) || lo === 0x09))
                    || (hi >= 0x00 && hi <= 0x04 && lo >= 0x80);
      var quebra = (hi === 0x00 && (lo === 0x0D || lo === 0x0A || lo === 0x07 || lo === 0x0B));
      if (imprimivel) {
        atual += String.fromCharCode((hi << 8) | lo);
      } else if (quebra) {
        if (atual.length >= minRun) trechos.push(atual);
        atual = '';
      } else {
        if (atual.length >= minRun) trechos.push(atual);
        atual = '';
      }
    }
    if (atual.length >= minRun) trechos.push(atual);

    var total = trechos.reduce(function (a, t) { return a + t.length; }, 0);

    // Fallback ASCII (Word 6/95 ou docs sem texto Unicode contíguo)
    if (total < 200) {
      trechos = [];
      atual = '';
      for (var j = 0; j < n; j++) {
        var b = bytes[j];
        if ((b >= 0x20 && b <= 0x7E) || b === 0x09) {
          atual += String.fromCharCode(b);
        } else if (b === 0x0D || b === 0x0A) {
          if (atual.length >= minRun) trechos.push(atual);
          atual = '';
        } else {
          if (atual.length >= minRun) trechos.push(atual);
          atual = '';
        }
      }
      if (atual.length >= minRun) trechos.push(atual);
    }

    return trechos.join('\n');
  }

  function converterTxt(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Falha ao ler ' + file.name)); };
      reader.onload = function (ev) {
        try {
          resolve({
            html: textoPlanoParaHtml(ev.target.result || ''),
            mensagens: [],
            imagensDescartadas: 0
          });
        } catch (e) { reject(e); }
      };
      reader.readAsText(file);
    });
  }

  function converterRtf(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Falha ao ler ' + file.name)); };
      reader.onload = function (ev) {
        try {
          var texto = rtfParaTexto(ev.target.result || '');
          resolve({
            html: textoPlanoParaHtml(texto),
            mensagens: [],
            imagensDescartadas: 0
          });
        } catch (e) { reject(e); }
      };
      reader.readAsText(file);
    });
  }

  function converterDocBinario(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Falha ao ler ' + file.name)); };
      reader.onload = function (ev) {
        try {
          var texto = extrairTextoDocBinario(ev.target.result);
          if (!texto || texto.length < 20) {
            reject(new Error('Não foi possível extrair texto de ' + file.name +
                             '. Salve no Word como .docx e reenvie.'));
            return;
          }
          resolve({
            html: textoPlanoParaHtml(texto),
            mensagens: [{
              type: 'warning',
              message: 'Extração de .doc é best-effort; .docx dá qualidade máxima.'
            }],
            imagensDescartadas: 0
          });
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Dispatcher por extensão.
  function converterArquivo(file) {
    var nome = (file.name || '').toLowerCase();
    if (/\.docx$/.test(nome)) return converterDocx(file);
    if (/\.txt$/.test(nome))  return converterTxt(file);
    if (/\.rtf$/.test(nome))  return converterRtf(file);
    if (/\.doc$/.test(nome))  return converterDocBinario(file);
    return Promise.reject(new Error('Formato não suportado: ' + file.name));
  }

  // ----------------------------------------------------------
  // Converte um File .docx para HTML via mammoth.js.
  //
  // O importador é apenas para texto — qualquer <img> gerada
  // pelo mammoth (logos, fotos coladas no laudo) é removida do
  // HTML antes do parsing. O número de imagens descartadas é
  // registrado para a UI mostrar um aviso por arquivo.
  //
  // Retorna Promise<{ html, mensagens, imagensDescartadas }>.
  // ----------------------------------------------------------
  function converterDocx(file) {
    return new Promise(function (resolve, reject) {
      if (!global.mammoth) {
        reject(new Error('mammoth.js não carregou.'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Falha ao ler ' + file.name)); };
      reader.onload = function (ev) {
        global.mammoth.convertToHtml({ arrayBuffer: ev.target.result })
          .then(function (resultado) {
            var html = resultado.value || '';
            var matches = html.match(/<img\b[^>]*>/gi);
            var imagensDescartadas = matches ? matches.length : 0;
            if (imagensDescartadas > 0) {
              html = html.replace(/<img\b[^>]*>/gi, '');
            }
            resolve({
              html: html,
              mensagens: resultado.messages || [],
              imagensDescartadas: imagensDescartadas
            });
          })
          .catch(reject);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // ----------------------------------------------------------
  // Pipeline completo de um arquivo:
  //   File -> HTML -> seções detectadas -> cláusulas
  // ----------------------------------------------------------
  function processarArquivo(file, tipo) {
    return converterArquivo(file).then(function (r) {
      var secoes = [];
      var orfaos = { paragrafos: [], clausulas: [] };
      var atual = null;

      var container = document.createElement('div');
      container.innerHTML = r.html;

      var blocos = container.querySelectorAll('p, h1, h2, h3, h4');

      blocos.forEach(function (p) {
        var detec = detectarSecao(p, tipo);
        if (detec) {
          var existente = secoes.filter(function (s) { return s.nome === detec.nome; })[0];
          if (existente) {
            atual = existente;
          } else {
            atual = { nome: detec.nome, rotuloOriginal: detec.rotuloOriginal, paragrafos: [] };
            secoes.push(atual);
          }
          if (detec.restoTexto) atual.paragrafos.push(detec.restoTexto);
          return;
        }
        var txt = (p.textContent || '').trim();
        if (!txt) return;
        if (atual) atual.paragrafos.push(txt);
        else       orfaos.paragrafos.push(txt);
      });

      // ----------------------------------------------------------
      // Classificação semântica de órfãos por âncoras.
      // Granularidade por SENTENÇA — médico pode escrever em prosa
      // contínua misturando esofago/estomago/duodeno num só parágrafo.
      // ----------------------------------------------------------
      var sentencasInferidas = 0;
      if (orfaos.paragrafos.length) {
        var restantes = [];
        orfaos.paragrafos.forEach(function (par) {
          quebrarSentencas(par).forEach(function (sent) {
            var classif = classificarSentenca(sent, tipo);
            if (classif) {
              var sec = secoes.filter(function (s) { return s.nome === classif.secao; })[0];
              if (!sec) {
                sec = {
                  nome: classif.secao,
                  rotuloOriginal: '(inferido)',
                  paragrafos: []
                };
                secoes.push(sec);
              }
              sec.paragrafos.push(sent);
              sentencasInferidas++;
            } else {
              restantes.push(sent);
            }
          });
        });
        orfaos.paragrafos = restantes;
      }

      // Fallback colono: o que sobrou de órfão vai para "exame"
      if (tipo === 'colono' && orfaos.paragrafos.length) {
        var exameSec = secoes.filter(function (s) { return s.nome === 'exame'; })[0];
        if (!exameSec) {
          exameSec = { nome: 'exame', rotuloOriginal: '(implícito)', paragrafos: [] };
          secoes.push(exameSec);
        }
        exameSec.paragrafos = orfaos.paragrafos.concat(exameSec.paragrafos);
        orfaos.paragrafos = [];
      }

      // Decompor cada seção em cláusulas (Camada 1) E em sentenças.
      // - clausulas: split fino por vírgula/ponto/e/ou (legado, cobertura curta)
      // - sentencas: split apenas por . ! ? — granularidade preferida pelo
      //   pipeline invertido (item busca melhor janela de N sentenças).
      secoes.forEach(function (s) {
        s.clausulas = [];
        s.sentencas = [];
        s.paragrafos.forEach(function (par, idxP) {
          quebrarSentencas(par).forEach(function (sent) {
            s.sentencas.push({
              texto: sent,
              paragrafoIdx: idxP,
              paragrafoOriginal: par
            });
          });
          decomporClausulas(par).forEach(function (c) {
            s.clausulas.push({ texto: c, paragrafoOriginal: par });
          });
        });
      });
      orfaos.sentencas = [];
      orfaos.paragrafos.forEach(function (par, idxP) {
        quebrarSentencas(par).forEach(function (sent) {
          orfaos.sentencas.push({
            texto: sent,
            paragrafoIdx: idxP,
            paragrafoOriginal: par
          });
        });
        decomporClausulas(par).forEach(function (c) {
          orfaos.clausulas.push({ texto: c, paragrafoOriginal: par });
        });
      });

      return {
        arquivo: file.name,
        html: r.html,
        secoes: secoes,
        orfaos: orfaos,
        avisosMammoth: r.mensagens,
        imagensDescartadas: r.imagensDescartadas || 0,
        sentencasInferidas: sentencasInferidas
      };
    });
  }

  // ----------------------------------------------------------
  // Processa array de Files em paralelo.
  // ----------------------------------------------------------
  function processarArquivos(files, tipo, callbacks) {
    callbacks = callbacks || {};
    var emProgresso = files.map(function (f, idx) {
      if (callbacks.aoIniciar) callbacks.aoIniciar(idx, f);
      return processarArquivo(f, tipo)
        .then(function (res) {
          if (callbacks.aoConcluir) callbacks.aoConcluir(idx, res);
          return res;
        })
        .catch(function (err) {
          if (callbacks.aoFalhar) callbacks.aoFalhar(idx, f, err);
          return { arquivo: f.name, erro: err.message || String(err) };
        });
    });
    return Promise.all(emProgresso);
  }

  // ----------------------------------------------------------
  // API pública
  // ----------------------------------------------------------
  global.ParserWord = {
    processarArquivos:    processarArquivos,
    processarArquivo:     processarArquivo,
    converterArquivo:     converterArquivo,
    decomporClausulas:    decomporClausulas,
    quebrarSentencas:     quebrarSentencas,
    classificarSentenca:  classificarSentenca,
    detectarSecao:        detectarSecao,
    casarSecao:           casarSecao,
    normalizar:           normalizar,
    rtfParaTexto:         rtfParaTexto,
    SINONIMOS:            SINONIMOS,
    ANCORAS:              ANCORAS
  };

})(window);
