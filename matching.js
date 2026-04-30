// ============================================================
// Gerar-Laudo-Importador — matching.js
// Pipeline conceitual de 4 camadas (§6 do PLANO):
//   - Camada 2: TF-IDF para extrair termos característicos
//   - Camada 3: score híbrido (conceito + Dice de bigramas)
//   - Camada 4: agregação por consenso multi-arquivo
//
// Camada 1 (decomposição em cláusulas) está em parser_word.js.
// ============================================================

(function (global) {
  'use strict';

  // ----------------------------------------------------------
  // Stopwords portuguesas (PLANO §6.3) + termos clínicos muito
  // genéricos que não distinguem itens entre si.
  // ----------------------------------------------------------
  var STOPWORDS_LISTA = [
    // Artigos, preposições, conjunções
    'a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e',
    'em', 'na', 'nas', 'no', 'nos', 'ou', 'os', 'para', 'pelo', 'pela',
    'pelos', 'pelas', 'por', 'que', 'se', 'ser', 'sem', 'sob', 'sobre',
    'um', 'uma', 'uns', 'umas',
    // Verbos auxiliares / cópulas
    'esta', 'estao', 'sao', 'tem', 'foi', 'sera', 'eh', 'ha', 'havia',
    // Conectivos
    'tambem', 'ainda', 'mais', 'menor', 'menores', 'maior', 'maiores',
    'cerca', 'aproximadamente', 'cerca de', 'apos', 'antes',
    // Quantificadores genéricos
    'todo', 'toda', 'todos', 'todas', 'algum', 'alguma', 'alguns', 'algumas',
    // Termos clínicos sem poder discriminativo entre itens
    'aspecto', 'preservado', 'preservada', 'preservados', 'preservadas',
    'normal', 'normais', 'ausencia', 'presenca', 'nivel', 'realizado',
    'realizada', 'apresenta', 'apresentam', 'observado', 'observada',
    'observa-se', 'paciente'
    // NOTA: NÃO incluímos 'mucosa', 'distensibilidade', 'lumen' — são
    // termos medicamente relevantes que aparecem em descrições específicas.
  ];
  var STOP = {};
  STOPWORDS_LISTA.forEach(function (w) { STOP[w] = true; });

  // ----------------------------------------------------------
  // Termos âncora: SEMPRE considerados característicos,
  // independente do score TF-IDF (PLANO §6.3).
  //
  // - Medidas: padrão "<numero><unidade>" ou variantes com vírgula
  // - Termos médicos consistentes em laudos endoscópicos
  // ----------------------------------------------------------
  var REGEX_MEDIDA = /^\d+(?:[.,]\d+)?(?:mm|cm|m)$/;
  var TERMOS_MEDICOS_ANCORA = [
    'metaplasia', 'displasia', 'ulcera', 'polipo', 'polipos', 'lesao', 'lesoes',
    'erosao', 'erosoes', 'cromoscopia', 'magnificacao', 'gastrite', 'esofagite',
    'helicobacter', 'pylori', 'barrett', 'hernia', 'hiatal', 'divertic',
    'estenose', 'tumor', 'massa', 'sangramento', 'sangue', 'eritematosa',
    'enantematica', 'edema', 'atrofia', 'atrofica', 'metaplasica',
    'inflamatoria', 'fibrina', 'anastomose', 'pincamento', 'diafragmatico',
    'transicao', 'esofagogastrica', 'gif', 'olympus', 'fujifilm', 'cf',
    'fentanil', 'midazolam', 'propofol', 'boston', 'fleet'
  ];
  var ANCORAS_SET = {};
  TERMOS_MEDICOS_ANCORA.forEach(function (t) { ANCORAS_SET[t] = true; });

  function ehAncora(token) {
    if (REGEX_MEDIDA.test(token)) return true;
    if (ANCORAS_SET[token]) return true;
    return false;
  }

  // ----------------------------------------------------------
  // Normalização (espelha parser_word.js para consistência).
  // ----------------------------------------------------------
  var REGEX_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

  function normalizar(s) {
    if (!s) return '';
    return String(s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .normalize('NFD').replace(REGEX_DIACRITICOS, '')
      .toLowerCase()
      // Cola medidas separadas por espaço: "5 mm" -> "5mm" (preserva
      // como token único reconhecível pela REGEX_MEDIDA).
      .replace(/(\d+(?:[.,]\d+)?)\s+(mm|cm|m)\b/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Tokeniza para TF-IDF: separadores não-alfanuméricos, descarta
  // stopwords, mantém tokens de tamanho >= 3 OU âncoras (medidas
  // tipo "5mm" têm 3+ chars; números curtos "h1" têm <3 mas não
  // são âncoras significativas — ignoramos).
  function tokenizar(texto) {
    var t = normalizar(texto);
    var brutos = t.split(/[^a-z0-9]+/i).filter(Boolean);
    return brutos.filter(function (w) {
      if (STOP[w]) return false;
      if (w.length >= 3) return true;
      return ehAncora(w);
    });
  }

  // ----------------------------------------------------------
  // CAMADA 2 — TF-IDF
  //
  // Para cada item da seção, extrai os top-N termos característicos
  // (maior score TF-IDF). Termos âncora são sempre incluídos, mesmo
  // se ficarem fora do top-N por baixo IDF.
  // ----------------------------------------------------------
  function construirPerfilSecao(itens, opts) {
    opts = opts || {};
    var topN = (typeof opts.topN === 'number') ? opts.topN : 8;
    if (!Array.isArray(itens) || itens.length === 0) return [];

    // Filtra apenas itens reais (com `valor`) — ignora separadores
    var itensValidos = itens.filter(function (it) {
      return it && it.valor && (it.nome || it.id);
    });
    if (itensValidos.length === 0) return [];

    // 1) Tokeniza cada item
    var docs = itensValidos.map(function (item) {
      return { item: item, tokens: tokenizar(item.valor) };
    });

    // 2) Document frequency (df) por token
    var df = {};
    docs.forEach(function (d) {
      var seen = {};
      d.tokens.forEach(function (t) {
        if (!seen[t]) {
          seen[t] = true;
          df[t] = (df[t] || 0) + 1;
        }
      });
    });

    var N = docs.length;

    // 3) TF-IDF por item
    return docs.map(function (d) {
      var tf = {};
      d.tokens.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });

      var lista = [];
      Object.keys(tf).forEach(function (t) {
        var idf = Math.log((N + 1) / ((df[t] || 0) + 1)) + 1;  // smoothed
        lista.push({
          termo: t,
          score: tf[t] * idf,
          tf: tf[t],
          idf: idf,
          ancora: ehAncora(t)
        });
      });

      lista.sort(function (a, b) { return b.score - a.score; });

      // Top-N + todas as âncoras (set evita varredura O(K²))
      var caracteristicos = lista.slice(0, topN);
      var caracSet = {};
      caracteristicos.forEach(function (c) { caracSet[c.termo] = true; });
      lista.forEach(function (entrada) {
        if (entrada.ancora && !caracSet[entrada.termo]) {
          caracteristicos.push(entrada);
          caracSet[entrada.termo] = true;
        }
      });

      return {
        item: d.item,
        tokens: d.tokens,
        termosCaracteristicos: caracteristicos,
        // Cachear bigramas evita recomputar para cada cláusula que
        // for comparada contra este item (Dice domina o tempo).
        bigramasItem: bigramasDe(d.item.valor || '')
      };
    });
  }

  function construirPerfil(db, opts) {
    var perfil = {};
    Object.keys(db || {}).forEach(function (chave) {
      if (!Array.isArray(db[chave])) return;
      perfil[chave] = construirPerfilSecao(db[chave], opts);
    });
    return perfil;
  }

  // ----------------------------------------------------------
  // CAMADA 3 — score híbrido (conceito + superfície)
  // ----------------------------------------------------------

  // score_conceito = (termos característicos do item presentes na
  // cláusula) / (total de termos característicos do item)
  function scoreConceito(clausulaTokens, perfilItem) {
    var carac = perfilItem.termosCaracteristicos;
    if (!carac.length) return 0;

    var setTokens = {};
    clausulaTokens.forEach(function (t) { setTokens[t] = true; });

    var presentes = 0;
    carac.forEach(function (c) {
      if (setTokens[c.termo]) presentes++;
    });
    return presentes / carac.length;
  }

  // ----------------------------------------------------------
  // Bigramas de caracteres (PLANO §6.4) — input é normalizado
  // antes (sem HTML, sem acentos, lowercase, espaços colapsados)
  // para que "esôfago" e "esofago" compartilhem todos os bigramas
  // e que o `<br>` em valores do banco colono não polua o set.
  // ----------------------------------------------------------
  function bigramasDe(s) {
    var r = {};
    var t = normalizar(s);
    for (var i = 0; i < t.length - 1; i++) {
      r[t.substring(i, i + 2)] = true;
    }
    return r;
  }

  // Dice a partir de dois sets de bigramas pré-computados.
  function diceFromBigramas(ba, bb) {
    var keysA = Object.keys(ba);
    var keysB = Object.keys(bb);
    if (keysA.length === 0 || keysB.length === 0) return 0;
    var inter = 0;
    keysA.forEach(function (k) { if (bb[k]) inter++; });
    return (2 * inter) / (keysA.length + keysB.length);
  }

  // Versão de conveniência: aceita strings cruas.
  function diceSimilaridade(a, b) {
    return diceFromBigramas(bigramasDe(a), bigramasDe(b));
  }

  function scoreFinal(conceito, superficie, pesoConceito) {
    if (typeof pesoConceito !== 'number') pesoConceito = 0.6;
    return pesoConceito * conceito + (1 - pesoConceito) * superficie;
  }

  // ----------------------------------------------------------
  // Calibração via slider de tolerância (PLANO §6.6)
  //
  // tolerancia ∈ [0, 100]   0 = rigoroso, 100 = permissivo
  //   limiar_match = 0.85 - tolerancia × 0.0030   (varia 0.85 → 0.55)
  //   limiar_novo  = 0.45 - tolerancia × 0.0020   (varia 0.45 → 0.25)
  // ----------------------------------------------------------
  function derivaLimiares(tolerancia) {
    var t = Math.max(0, Math.min(100, Number(tolerancia) || 0));
    return {
      tolerancia:   t,
      limiarMatch:  0.85 - t * 0.0030,
      limiarNovo:   0.45 - t * 0.0020
    };
  }

  // Classifica um score final de match item×janela em uma de 4 faixas:
  //   - 'match'         banco já bate com o laudo (não atualizar)
  //   - 'atualizacao'   propor refinar texto do banco
  //   - 'variante'      revisar com cuidado
  //   - 'naoEncontrado' item não está no laudo (ignorar)
  function classificarScore(final, tolerancia) {
    var L = derivaLimiares(tolerancia);
    if (final == null) return 'naoEncontrado';
    if (final >= L.limiarMatch)  return 'match';
    if (final >= 0.65)           return 'atualizacao';
    if (final >= L.limiarNovo)   return 'variante';
    return 'naoEncontrado';
  }

  // ----------------------------------------------------------
  // Casa cláusulas contra itens do banco da MESMA seção,
  // calculando todos os 3 scores. Retorna lista plana com top-K
  // matches por cláusula.
  // ----------------------------------------------------------
  function casarClausulas(clausulasPorSecao, perfil, opts) {
    opts = opts || {};
    var topMatches = (typeof opts.topMatches === 'number') ? opts.topMatches : 3;
    var pesoConceito = (typeof opts.pesoConceito === 'number')
      ? opts.pesoConceito : 0.6;

    var resultados = [];
    Object.keys(clausulasPorSecao).forEach(function (secao) {
      var perfilSec = perfil[secao];
      var listaItens = (perfilSec && perfilSec.length) ? perfilSec : null;

      clausulasPorSecao[secao].forEach(function (c) {
        var tokens = tokenizar(c.texto);
        if (!listaItens) {
          resultados.push({
            secao: secao,
            clausula: c,
            tokens: tokens,
            matches: [],
            melhor: null
          });
          return;
        }

        // Bigramas da cláusula computados UMA vez e reusados
        // contra todos os itens da seção (Dice é o hot-path).
        var bigsClausula = bigramasDe(c.texto);

        var matches = listaItens.map(function (p) {
          var conc = scoreConceito(tokens, p);
          var sup  = diceFromBigramas(bigsClausula, p.bigramasItem);
          var fin  = scoreFinal(conc, sup, pesoConceito);
          return {
            item: p.item,
            conceito: conc,
            superficie: sup,
            final: fin
          };
        });
        matches.sort(function (a, b) { return b.final - a.final; });

        resultados.push({
          secao: secao,
          clausula: c,
          tokens: tokens,
          bigramas: bigsClausula,
          matches: matches.slice(0, topMatches),
          melhor: matches[0] || null
        });
      });
    });
    return resultados;
  }

  // ----------------------------------------------------------
  // CAMADA 4 — agregação por consenso multi-arquivo
  //
  // Para cada item do banco, coleta as cláusulas que matcharam
  // acima do limiar, agrupa por similaridade Dice >= threshold,
  // e ranqueia grupos por frequência (qtd de arquivos distintos).
  // O grupo maior vira a "versão consenso" (proposta de
  // atualização para Fase 5).
  // ----------------------------------------------------------
  function agregarConsenso(scoresPorArquivo, opts) {
    opts = opts || {};
    // Usar typeof number — `||` trata 0 como falsy e cairia no default,
    // impedindo o caller de desligar os limiares passando 0.
    var diceThreshold = (typeof opts.diceThreshold === 'number')
      ? opts.diceThreshold : 0.85;
    var limiarMatch   = (typeof opts.limiarMatch === 'number')
      ? opts.limiarMatch   : 0.65;

    // bucket[secao][itemKey] = { item, candidatos: [{clausula, score, arquivo}] }
    var bucket = {};

    scoresPorArquivo.forEach(function (porArq) {
      (porArq.scores || []).forEach(function (r) {
        if (!r.melhor || r.melhor.final < limiarMatch) return;
        var item = r.melhor.item;
        var key = (item && (item.id || item.nome)) || 'sem-id';
        if (!bucket[r.secao]) bucket[r.secao] = {};
        if (!bucket[r.secao][key]) bucket[r.secao][key] = { item: item, candidatos: [] };
        bucket[r.secao][key].candidatos.push({
          clausula: r.clausula,
          score:    r.melhor,
          arquivo:  porArq.arquivo
        });
      });
    });

    var resultado = {};
    Object.keys(bucket).forEach(function (secao) {
      resultado[secao] = [];
      Object.keys(bucket[secao]).forEach(function (key) {
        var info = bucket[secao][key];
        var grupos = agruparPorSimilaridade(info.candidatos, diceThreshold);
        grupos.sort(function (a, b) { return b.membros.length - a.membros.length; });

        var topo = grupos[0];
        var arquivosTopo = {};
        if (topo) topo.membros.forEach(function (m) { arquivosTopo[m.arquivo] = true; });

        resultado[secao].push({
          item:               info.item,
          grupoConsenso:      topo || null,
          variantes:          grupos.slice(1),
          frequenciaArquivos: Object.keys(arquivosTopo).length,
          totalCandidatos:    info.candidatos.length
        });
      });
      resultado[secao].sort(function (a, b) {
        return b.frequenciaArquivos - a.frequenciaArquivos;
      });
    });

    return resultado;
  }

  // Single-link clustering por similaridade Dice >= threshold,
  // representante = primeira cláusula a iniciar o grupo.
  // Cacheia bigramas dos representantes para evitar recomputo.
  function agruparPorSimilaridade(candidatos, diceThreshold) {
    var grupos = [];
    candidatos.forEach(function (c) {
      var bigs = bigramasDe(c.clausula.texto);
      var encaixou = false;
      for (var i = 0; i < grupos.length; i++) {
        if (diceFromBigramas(bigs, grupos[i].bigramasRep) >= diceThreshold) {
          grupos[i].membros.push(c);
          encaixou = true;
          break;
        }
      }
      if (!encaixou) {
        grupos.push({
          representante: c.clausula,
          bigramasRep: bigs,
          membros: [c]
        });
      }
    });
    // Limpa o campo interno antes de retornar
    return grupos.map(function (g) {
      return { representante: g.representante, membros: g.membros };
    });
  }

  // ============================================================
  // PIPELINE INVERTIDO (item -> janela)
  //
  // Mantém detecção de seções (do parser). Dentro de cada seção,
  // para cada item do banco, gera todas as janelas contíguas de
  // 1..N sentenças e elege a janela com maior score híbrido como
  // "trecho candidato à substituição". Sentenças não cobertas por
  // nenhuma janela vencedora viram candidatos a NOVOS itens.
  // ============================================================

  // Gera janelas de tamanho 1..maxTamanho a partir de uma lista
  // de sentenças. Cada janela referencia [inicio, fim] inclusivos.
  function gerarJanelas(sentencas, maxTamanho) {
    var janelas = [];
    for (var i = 0; i < sentencas.length; i++) {
      for (var t = 1; t <= maxTamanho && (i + t) <= sentencas.length; t++) {
        var slice = sentencas.slice(i, i + t);
        janelas.push({
          inicio:    i,
          fim:       i + t - 1,
          tamanho:   t,
          sentencas: slice,
          texto:     slice.map(function (s) { return s.texto; }).join(' ')
        });
      }
    }
    return janelas;
  }

  // Pré-computa tokens e bigramas de cada janela (reuso entre itens).
  function preProcessarJanelas(janelas) {
    janelas.forEach(function (j) {
      j.tokens   = tokenizar(j.texto);
      j.bigramas = bigramasDe(j.texto);
    });
  }

  // Para um item e suas janelas pré-processadas, encontra a janela
  // com maior score final.
  function melhorJanelaParaItem(janelas, itemPerfil, opts) {
    var pesoConceito = (typeof opts.pesoConceito === 'number')
      ? opts.pesoConceito : 0.6;

    var melhor = null;
    janelas.forEach(function (j) {
      var conc = scoreConceito(j.tokens, itemPerfil);
      var sup  = diceFromBigramas(j.bigramas, itemPerfil.bigramasItem);
      var fin  = scoreFinal(conc, sup, pesoConceito);
      if (!melhor || fin > melhor.score.final) {
        melhor = {
          janela: j,
          score: { conceito: conc, superficie: sup, final: fin }
        };
      }
    });
    return melhor;
  }

  // Pipeline por seção: para cada item, busca melhor janela.
  function caçarItensEmSecao(sentencas, perfilSec, opts) {
    opts = opts || {};
    var maxTam = (typeof opts.tamanhoMaxJanela === 'number')
      ? opts.tamanhoMaxJanela : 4;

    if (!sentencas.length || !perfilSec || !perfilSec.length) {
      return { sentencas: sentencas, matchesPorItem: [], janelas: [] };
    }

    var janelas = gerarJanelas(sentencas, maxTam);
    preProcessarJanelas(janelas);

    var matchesPorItem = perfilSec.map(function (p) {
      return {
        item:   p.item,
        perfil: p,
        melhor: melhorJanelaParaItem(janelas, p, opts)
      };
    });

    return {
      sentencas:      sentencas,
      janelas:        janelas,
      matchesPorItem: matchesPorItem
    };
  }

  // Detecta sentenças não cobertas por janelas vencedoras com score
  // acima do threshold. Devolve grupos contíguos de sentenças órfãs
  // como candidatos a NOVOS itens.
  function detectarItensNovos(sentencas, matchesPorItem, threshold) {
    var coberta = [];
    for (var i = 0; i < sentencas.length; i++) coberta.push(false);

    matchesPorItem.forEach(function (mpi) {
      if (!mpi.melhor || mpi.melhor.score.final < threshold) return;
      var j = mpi.melhor.janela;
      for (var k = j.inicio; k <= j.fim; k++) coberta[k] = true;
    });

    var grupos = [];
    var atual = null;
    for (var i = 0; i < sentencas.length; i++) {
      if (!coberta[i]) {
        if (!atual) atual = { inicio: i, sentencas: [] };
        atual.sentencas.push(sentencas[i]);
      } else if (atual) {
        grupos.push({
          inicio:    atual.inicio,
          sentencas: atual.sentencas,
          texto:     atual.sentencas.map(function (s) { return s.texto; }).join(' ')
        });
        atual = null;
      }
    }
    if (atual) {
      grupos.push({
        inicio:    atual.inicio,
        sentencas: atual.sentencas,
        texto:     atual.sentencas.map(function (s) { return s.texto; }).join(' ')
      });
    }
    return grupos;
  }

  // ----------------------------------------------------------
  // Agrega cláusulas-candidatas POR ITEM através dos arquivos.
  // (Camada 4 do PLANO, adaptada ao pipeline invertido.)
  //
  // Para cada (secao, item), coleta as melhores janelas de cada
  // arquivo onde o score >= limiarMatch, agrupa por similaridade
  // (Dice >= diceThreshold), e ranqueia grupos por frequência
  // de arquivos distintos.
  // ----------------------------------------------------------
  function agregarConsensoPorItem(porArquivo, opts) {
    opts = opts || {};
    var diceThreshold = (typeof opts.diceThreshold === 'number')
      ? opts.diceThreshold : 0.85;
    var limiarMatch = (typeof opts.limiarMatch === 'number')
      ? opts.limiarMatch : 0.65;

    // bucket[secao][itemKey] = { item, candidatos: [{texto, score, arquivo}] }
    var bucket = {};

    porArquivo.forEach(function (pa) {
      (pa.secoes || []).forEach(function (sec) {
        (sec.matchesPorItem || []).forEach(function (mpi) {
          if (!mpi.melhor || mpi.melhor.score.final < limiarMatch) return;
          var key = (mpi.item.id || mpi.item.nome) || 'sem-id';
          if (!bucket[sec.nome]) bucket[sec.nome] = {};
          if (!bucket[sec.nome][key]) {
            bucket[sec.nome][key] = { item: mpi.item, candidatos: [] };
          }
          bucket[sec.nome][key].candidatos.push({
            texto:    mpi.melhor.janela.texto,
            sentencas: mpi.melhor.janela.sentencas,
            score:    mpi.melhor.score,
            arquivo:  pa.arquivo
          });
        });
      });
    });

    var resultado = {};
    Object.keys(bucket).forEach(function (secao) {
      resultado[secao] = [];
      Object.keys(bucket[secao]).forEach(function (key) {
        var info = bucket[secao][key];
        var grupos = agruparTextosPorSimilaridade(
          info.candidatos.map(function (c) { return { texto: c.texto, ref: c }; }),
          diceThreshold
        );
        grupos.sort(function (a, b) { return b.membros.length - a.membros.length; });

        var topo = grupos[0];
        var arqs = {};
        if (topo) topo.membros.forEach(function (m) { arqs[m.ref.arquivo] = true; });

        resultado[secao].push({
          item:               info.item,
          grupoConsenso:      topo || null,
          variantes:          grupos.slice(1),
          frequenciaArquivos: Object.keys(arqs).length,
          totalCandidatos:    info.candidatos.length
        });
      });
      resultado[secao].sort(function (a, b) {
        return b.frequenciaArquivos - a.frequenciaArquivos;
      });
    });
    return resultado;
  }

  // Agrega candidatos a NOVOS itens entre arquivos.
  function agregarNovosItens(porArquivo, opts) {
    opts = opts || {};
    var diceThreshold = (typeof opts.diceThresholdNovos === 'number')
      ? opts.diceThresholdNovos : 0.65;

    var bucket = {};  // secao -> [{texto, arquivo, sentencas}]
    porArquivo.forEach(function (pa) {
      (pa.secoes || []).forEach(function (sec) {
        (sec.itensNovos || []).forEach(function (g) {
          if (!bucket[sec.nome]) bucket[sec.nome] = [];
          bucket[sec.nome].push({
            texto:     g.texto,
            sentencas: g.sentencas,
            arquivo:   pa.arquivo
          });
        });
      });
    });

    var resultado = {};
    Object.keys(bucket).forEach(function (secao) {
      var grupos = agruparTextosPorSimilaridade(
        bucket[secao].map(function (c) { return { texto: c.texto, ref: c }; }),
        diceThreshold
      );
      grupos.sort(function (a, b) { return b.membros.length - a.membros.length; });
      resultado[secao] = grupos.map(function (g) {
        var arqs = {};
        g.membros.forEach(function (m) { arqs[m.ref.arquivo] = true; });
        return {
          representante:      g.representante,
          membros:            g.membros,
          frequenciaArquivos: Object.keys(arqs).length,
          totalCandidatos:    g.membros.length
        };
      });
    });
    return resultado;
  }

  // Agrupador genérico: input [{ texto, ref }], output grupos.
  function agruparTextosPorSimilaridade(itens, diceThreshold) {
    var grupos = [];
    itens.forEach(function (it) {
      var bigs = bigramasDe(it.texto);
      var encaixou = false;
      for (var i = 0; i < grupos.length; i++) {
        if (diceFromBigramas(bigs, grupos[i].bigramasRep) >= diceThreshold) {
          grupos[i].membros.push(it.ref);
          encaixou = true;
          break;
        }
      }
      if (!encaixou) {
        grupos.push({
          representante: it.texto,
          bigramasRep:   bigs,
          membros:       [it.ref]
        });
      }
    });
    return grupos.map(function (g) {
      return { representante: g.representante, membros: g.membros };
    });
  }

  // ----------------------------------------------------------
  // Pipeline orquestrador (NOVO — invertido).
  // ----------------------------------------------------------
  function analisar(resultadosParser, db, opts) {
    opts = opts || {};
    var topN = (typeof opts.topN === 'number') ? opts.topN : 8;
    var thresholdCobertura = (typeof opts.thresholdCobertura === 'number')
      ? opts.thresholdCobertura : 0.50;

    var perfil = construirPerfil(db, { topN: topN });

    var porArquivo = (resultadosParser || []).map(function (r) {
      if (r.erro) {
        return { arquivo: r.arquivo, secoes: [], erro: r.erro };
      }

      var secoesProcessadas = (r.secoes || []).map(function (s) {
        var sentencas = s.sentencas || [];
        var perfilSec = perfil[s.nome] || [];
        var resultado = caçarItensEmSecao(sentencas, perfilSec, opts);
        var novos     = detectarItensNovos(sentencas, resultado.matchesPorItem,
                                           thresholdCobertura);

        return {
          nome:           s.nome,
          rotuloOriginal: s.rotuloOriginal,
          sentencas:      sentencas,
          matchesPorItem: resultado.matchesPorItem,
          itensNovos:     novos
        };
      });

      return { arquivo: r.arquivo, secoes: secoesProcessadas };
    });

    var consenso      = agregarConsensoPorItem(porArquivo, opts);
    var consensoNovos = agregarNovosItens(porArquivo, opts);

    return {
      perfil:        perfil,
      porArquivo:    porArquivo,
      consenso:      consenso,
      consensoNovos: consensoNovos
    };
  }

  // ----------------------------------------------------------
  // API pública
  // ----------------------------------------------------------
  global.Matching = {
    // Pipeline novo (invertido)
    analisar:             analisar,
    caçarItensEmSecao:    caçarItensEmSecao,
    gerarJanelas:         gerarJanelas,
    melhorJanelaParaItem: melhorJanelaParaItem,
    detectarItensNovos:   detectarItensNovos,
    agregarConsensoPorItem: agregarConsensoPorItem,
    agregarNovosItens:    agregarNovosItens,

    // Utilitários compartilhados
    construirPerfil:      construirPerfil,
    construirPerfilSecao: construirPerfilSecao,
    scoreConceito:        scoreConceito,
    scoreFinal:           scoreFinal,
    derivaLimiares:       derivaLimiares,
    classificarScore:     classificarScore,
    diceSimilaridade:     diceSimilaridade,
    diceFromBigramas:     diceFromBigramas,
    bigramasDe:           bigramasDe,
    tokenizar:            tokenizar,
    normalizar:           normalizar,
    ehAncora:             ehAncora,

    // ===== DEPRECATED =====
    // API legada (cláusula -> item). NÃO usar no fluxo principal —
    // mantida apenas para casos de teste antigos. A `analisar`
    // pública usa o pipeline invertido (item -> janela).
    casarClausulas:       casarClausulas,
    agregarConsenso:      agregarConsenso,

    STOPWORDS:            STOPWORDS_LISTA,
    TERMOS_MEDICOS_ANCORA: TERMOS_MEDICOS_ANCORA
  };

})(window);
