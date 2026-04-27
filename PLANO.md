# PLANO.md — Gerar-Laudo-Importador

> Especificação para implementação. Léia este arquivo inteiro antes de escrever qualquer linha de código.
>
> **Versão 2** — incorpora pipeline de matching conceitual em 4 camadas e calibração ao vivo via slider de tolerância.

## 1. Visão geral

Aplicação web que permite a médicos endoscopistas fazer upload de laudos prontos em formato Word (`.docx`), o sistema analisa esses laudos, identifica padrões de texto que correspondem aos itens existentes no banco de dados pessoal do usuário no Firebase, e — mediante aprovação explícita do usuário — atualiza esse banco com:

- **Refinamentos de texto** dos itens já existentes (o jeito como o médico realmente escreve cada achado)
- **Novos itens** que apareceram nos laudos mas ainda não existem no banco

Funciona em duas variantes — laudos de EDA (endoscopia digestiva alta) e laudos de colonoscopia — selecionadas via parâmetro de URL.

A grande diferença em relação a sistemas simples de comparação de texto: o matching é **conceitual**, não literal. O sistema reconhece que "esôfago de calibre preservado com erosões pequenas <5mm na TEG" e "calibre e distensibilidade preservados, presença de erosões menores que 5 mm ao nível da transição esofagogástrica" descrevem o mesmo achado, mesmo escritos de formas bem diferentes.

## 2. Repositórios envolvidos

| Repositório | Papel | URL |
|---|---|---|
| `Gerar-laudo-EDA` | App gerador de laudos EDA (existente) | https://ekmogawa.github.io/Gerar-laudo-EDA/ |
| `Gerar-Laudo-Colono` | App gerador de laudos Colonoscopia (existente) | https://ekmogawa.github.io/Gerar-Laudo-Colono/ |
| `Gerar-Laudo-Importador` | Esta aplicação (novo repo) | https://ekmogawa.github.io/Gerar-Laudo-Importador/ |

Os dois apps existentes compartilham o mesmo projeto Firebase (`gerar-laudo-eda`) e os mesmos usuários. Cada usuário tem um único documento em `users/{uid}` contendo dois campos separados — `dbEDA` e `dbColono`.

## 3. Arquitetura escolhida

**Repositório único compartilhado**, hospedado em GitHub Pages.

Mesma página HTML serve ambas as especialidades, com o tipo determinado pela URL:

```
https://ekmogawa.github.io/Gerar-Laudo-Importador/?tipo=eda
https://ekmogawa.github.io/Gerar-Laudo-Importador/?tipo=colono
```

A integração com os apps existentes é feita via dois botões (um em cada app) que apontam para a URL com o parâmetro correto.

### Stack técnica

- HTML/CSS/JavaScript puro (sem framework) — para manter consistência com os apps existentes
- Firebase SDK compat v9 (mesma versão usada nos apps existentes — `firebase.auth()`, `firebase.firestore()`)
- mammoth.js via CDN — converte `.docx` para HTML/texto no navegador
- Sem servidor backend, sem Cloud Functions, sem chaves de API expostas

## 4. Contrato de dados Firebase

Esta é a parte mais crítica do projeto. O importador grava no mesmo documento que os apps geradores leem — qualquer divergência de formato quebra os geradores.

### Coleção e documento

```
users/{uid}
  ├─ dbEDA:              { equipamento: [...], sedacao: [...], esofago: [...], ... }
  ├─ dbColono:           { equipamento: [...], sedacao: [...], colon: [...], ... }
  ├─ email:              "usuario@exemplo.com"
  ├─ atualizadoEm:       <serverTimestamp>
  └─ importadorConfig:   { tolerancia: 50, pesoConceito: 0.6 }   // novo, ver seção 8
```

### Estrutura de cada item

Dentro de cada seção (`esofago`, `estomago`, etc.), o array contém objetos no formato:

```javascript
{
  nome: "LAA",                       // rótulo do checkbox (obrigatório)
  id:   "checkbox5",                 // identificador único (opcional)
  valor: "calibre e distensibilidade preservados..."  // texto do laudo (obrigatório)
}
```

Itens podem também ser separadores: `{ separador: true }`.

### Padrão de leitura

```javascript
const doc = await _firestore.collection('users').doc(_user.uid).get();
const dados = doc.exists && doc.data()['dbEDA'] ? doc.data()['dbEDA'] : null;
```

### Padrão de escrita (preserva o outro campo via merge)

```javascript
await _firestore.collection('users').doc(_user.uid).set(
  {
    dbEDA: novoDB,           // ou dbColono — APENAS o campo da especialidade ativa
    atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
  },
  { merge: true }            // CRÍTICO: não sobrescrever o outro campo
);
```

**Regra de ouro**: o importador NUNCA toca no campo da outra especialidade. Importador de EDA só lê e escreve `dbEDA`. Importador de Colono só lê e escreve `dbColono`. O `merge: true` é obrigatório.

## 5. Fluxo do usuário

1. **Login** — tela inicial pede email/senha (Firebase Auth). Mesmo cadastro dos apps existentes.
2. **Detecção de tipo** — a página lê `?tipo=eda` ou `?tipo=colono` da URL e ajusta o título, as seções esperadas e qual campo Firestore usar.
3. **Upload** — drag-and-drop ou seletor de arquivos. Aceita 1 a 20 arquivos `.docx` por vez.
4. **Processamento local** — mammoth.js converte cada arquivo para HTML/texto, sem enviar nada para servidor. Indicador de progresso por arquivo.
5. **Análise em 4 camadas** — pipeline conceitual descrito na seção 6. Esta etapa é computada uma única vez e os scores brutos ficam em memória.
6. **Calibração ao vivo** — tela com slider de tolerância. Usuário arrasta e os contadores ("matches: X, atualizações: Y, novos: Z") atualizam em tempo real, sem reprocessamento.
7. **Revisão** — tela mostra todas as propostas agrupadas por seção, classificadas conforme a tolerância escolhida. Para cada proposta:
   - Texto atual no Firebase (se houver)
   - Texto proposto (extraído do Word)
   - Frequência (em quantos laudos apareceu)
   - Score conceitual e score de superfície (transparência)
   - Botões: **Aceitar** / **Ignorar** / **Editar antes de aceitar**
8. **Confirmação** — botão "Aplicar alterações no Firebase" só fica ativo depois de o usuário ter revisado pelo menos uma proposta. Mostra modal: "Você está prestes a alterar X itens e criar Y novos no banco da especialidade [EDA/Colono]. Confirmar?"
9. **Gravação** — única chamada `set({}, { merge: true })` para o Firestore. Snapshot anterior salvo em `users/{uid}/imports/{timestamp}` para reversão.
10. **Volta** — botão para voltar ao app gerador correspondente.

## 6. Algoritmo de detecção e matching — pipeline conceitual de 4 camadas

Esta é a peça intelectual do projeto. Implementação cuidadosa aqui economiza muita frustração depois.

### 6.1 Detecção de seções

Aplicada em ordem de confiabilidade. A primeira que casar vence.

1. **Negrito + dois pontos** — `<strong>Esôfago:</strong>` no HTML do mammoth → seção
2. **Lista de termos conhecidos** — se a linha começa com um termo da lista de seções esperadas (configurável por especialidade) seguido de `:` → seção
3. **Linha curta isolada** — linha com menos de 30 caracteres, em maiúsculas ou capitalizada, sozinha em seu parágrafo → seção (fallback)

Lista por especialidade (validar e ajustar conforme `dados_eda.js` e `dados_colono.js`):

```javascript
const SECOES_EDA = [
  'Equipamento', 'Sedação', 'Esôfago', 'Estômago',
  'Duodeno', 'Jejuno', 'Outros', 'Conclusão'
];

const SECOES_COLONO = [
  'Equipamento', 'Sedação', 'Preparo', 'Reto', 'Sigmoide',
  'Cólon descendente', 'Cólon transverso', 'Cólon ascendente',
  'Ceco', 'Íleo terminal', 'Outros', 'Conclusão'
];
```

### 6.2 Camada 1 — Decomposição em cláusulas

Médicos frequentemente escrevem múltiplos achados num único parágrafo separados por vírgula ou "e". O matching parágrafo-a-parágrafo perde isso. A solução é decompor antes de comparar.

Para cada parágrafo numa seção:

1. Quebrar em sentenças por `. ` `! ` `? `
2. Dentro de cada sentença, quebrar em cláusulas por `, ` `; ` ` e ` ` ou `
3. Descartar cláusulas com menos de 3 palavras (são conectivos ou ruído)
4. Manter referência ao parágrafo original (para mostrar contexto na revisão)

Exemplo: `"Esôfago de calibre preservado, com erosões pequenas <5mm na TEG, sem hérnia hiatal"` → 3 cláusulas independentes que serão comparadas separadamente contra os itens do Firebase.

### 6.3 Camada 2 — Termos característicos (TF-IDF)

Para cada item já existente em `dbEDA`/`dbColono`, o sistema extrai automaticamente as palavras que **distinguem** aquele item dos outros itens da mesma seção. Isso é feito uma única vez quando o banco do usuário é carregado.

Algoritmo:

1. Para cada palavra no `valor` do item:
   - Remover acentos, normalizar para minúsculas
   - Descartar stopwords portuguesas (lista abaixo)
2. Calcular TF-IDF: `tf(palavra, item) × idf(palavra, secao)`
   - `tf` = quantas vezes a palavra aparece neste item
   - `idf` = `log(total_itens_na_secao / numero_de_itens_que_contem_a_palavra)`
3. Ordenar por score decrescente
4. Pegar as 5-8 palavras com maior score → são os termos característicos do item

Exemplo de stopwords portuguesas (não exaustivo, ajustar com uso):
```
a, ao, aos, as, com, da, das, de, do, dos, e, em, na, nas, no, nos, ou,
para, pelo, pela, pelos, pelas, por, que, se, ser, sem, sob, sobre, um,
uma, uns, umas, é, está, são, têm, foi
```

**Termos âncora** — sempre considerados característicos independente de TF-IDF:
- Medidas: `mm`, `cm`, `m`, números seguidos de unidade
- Termos médicos consistentes: `metaplasia`, `displasia`, `úlcera`, `pólipo`, `lesão`, `erosão`, `cromoscopia`, etc. (lista expansível conforme uso)

### 6.4 Camada 3 — Matching híbrido (conceito + superfície)

Para cada cláusula do Word (Camada 1) contra cada item do Firebase na mesma seção:

**Score de conceito** (0 a 1):
```
termos_encontrados = quantos termos característicos do item aparecem na cláusula
score_conceito = termos_encontrados / total_de_termos_caracteristicos_do_item
```

**Score de superfície** (0 a 1):
- Dice coefficient sobre bigramas de caracteres (algoritmo abaixo)

**Score final** (combinação ponderada):
```
score_final = (peso_conceito × score_conceito) + ((1 - peso_conceito) × score_superficie)
```

`peso_conceito` é configurável via slider avançado. Default: 0.6 (60% conceito, 40% superfície).

Implementação do Dice coefficient:

```javascript
function diceSimilaridade(a, b) {
  const bigramas = s => {
    const r = new Set();
    s = s.toLowerCase().replace(/\s+/g, ' ').trim();
    for (let i = 0; i < s.length - 1; i++) r.add(s.substring(i, i + 2));
    return r;
  };
  const ba = bigramas(a), bb = bigramas(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  const intersecao = [...ba].filter(x => bb.has(x)).length;
  return (2 * intersecao) / (ba.size + bb.size);
}
```

### 6.5 Camada 4 — Agregação por consenso multi-arquivo

Quando múltiplos laudos são enviados, a mesma cláusula geralmente aparece com pequenas variações em vários deles. O sistema usa essa redundância como sinal de confiança.

Para cada item do Firebase, depois de calcular scores contra todas as cláusulas de todos os arquivos:

1. Filtrar cláusulas com `score_final` acima do limiar de match
2. Agrupar cláusulas similares entre si (Dice ≥ 0.85 entre as cláusulas) — são variantes da mesma frase
3. Ordenar grupos por tamanho (frequência)
4. O grupo mais frequente vira a "versão consenso" → é a versão proposta para atualização
5. Anotar frequência: "Apareceu em 12 de 15 laudos"
6. Se a frequência máxima for menor que 30% dos arquivos enviados, marcar como "baixa confiança"

### 6.6 Classificação final por limiares

Os limiares são derivados do **slider de tolerância** (única variável que o usuário ajusta no fluxo principal):

```
tolerancia ∈ [0, 100]   // 0 = rigoroso, 100 = permissivo

limiar_match     = 0.85 - (tolerancia × 0.0030)   // varia de 0.85 a 0.55
limiar_novo      = 0.45 - (tolerancia × 0.0020)   // varia de 0.45 a 0.25
```

Classificação:

| score_final | Classificação | Cor sugerida |
|---|---|---|
| ≥ limiar_match | Match perfeito (já está no banco) | verde, dispensa atenção |
| 0.65 a < limiar_match | Atualização proposta | azul, ação principal |
| limiar_novo a < 0.65 | Possível variante (revisar com cuidado) | amarelo |
| < limiar_novo | Item novo | laranja, criar checkbox |

A classificação acontece em memória — quando o usuário arrasta o slider, apenas os limiares mudam e a tabela é re-renderizada. Sem reprocessamento dos arquivos.

## 7. Tela de revisão — requisitos detalhados

### Layout

- **Topo fixo (sticky)**: slider de tolerância + contadores ao vivo
- **Painel principal**: lista de propostas agrupadas por seção
- **Rodapé fixo**: contador "X de Y propostas revisadas" + botão "Aplicar alterações"

### Slider de tolerância

- Posição visível no topo, sempre acessível
- Escala de 0 (rigoroso) a 100 (permissivo)
- Default: 50
- Ao lado do slider, contadores ao vivo: `Matches: 12 | Atualizações: 8 | Variantes: 4 | Novos: 6`
- Botão "Avançado" expande controle adicional: slider de "peso conceito vs texto" (default 60%)
- Valores escolhidos são salvos em `users/{uid}.importadorConfig` ao final, para próxima sessão

### Cada proposta mostra

- **Nome do item** (existente ou sugestão de nome para novos)
- **Texto atual no Firebase** (se for atualização) — exibido com strikethrough opcional
- **Texto proposto** (extraído do Word) — destacado
- **Diff visual** quando for atualização: palavras novas em verde, removidas em vermelho
- **Frequência**: "Apareceu em 12 de 15 laudos"
- **Scores em tooltip**: hover mostra "Conceito: 0.82, Superfície: 0.41, Final: 0.66"
- **Botões**: Aceitar | Ignorar | Editar antes de aceitar
- Para "Editar antes de aceitar": campo de texto editável aparece inline

### Filtros

- "Mostrar tudo" (default)
- "Só atualizações"
- "Só novos"
- "Só baixa confiança"
- "Só não revisados"

### Ações em massa

- "Aceitar todos os matches da seção"
- "Ignorar todos com baixa confiança"

## 8. Configurações persistidas

Cada usuário tem suas próprias preferências de calibração, salvas em:

```
users/{uid}/
  └─ importadorConfig: {
       tolerancia:     50,        // posição do slider (0-100)
       pesoConceito:   0.6,       // peso do score conceitual
       limiarConsenso: 0.30       // % mínima para considerar não-baixa-confiança
     }
```

Carregadas no início de cada sessão. Salvas ao final de cada importação bem-sucedida.

## 9. Segurança e garantias

Estas são regras inegociáveis do projeto:

1. **Login obrigatório** — sem usuário autenticado, a página fica em estado de login. Modo visitante não tem acesso a este aplicativo.
2. **Aprovação explícita** — nenhuma gravação no Firebase acontece sem o usuário clicar em "Aplicar alterações". Sem auto-save, sem gravação parcial durante a navegação.
3. **Isolamento de campos** — importador de EDA NUNCA toca em `dbColono` e vice-versa. Sempre `set({}, { merge: true })`.
4. **Processamento local** — os arquivos `.docx` são lidos no navegador via mammoth.js. Nada é enviado para nenhum servidor além do Firebase final.
5. **Confirmação dupla** — antes da gravação final, mostrar modal: "Você está prestes a alterar X itens e criar Y novos no banco da especialidade [EDA/Colono]. Confirmar?"
6. **Sem chaves de API expostas** — usar apenas o `firebase-config.js` (que é público por design) e nenhuma outra credencial.
7. **Snapshot antes de gravar** — sempre salvar `dbAnterior` em `users/{uid}/imports/{timestamp}` antes de aplicar alterações.

## 10. Histórico de importações (rede de segurança)

Para permitir reversão se o médico perceber que aceitou algo errado:

```
users/{uid}/imports/{timestampISO}
  ├─ tipo:                "eda" | "colono"
  ├─ realizadoEm:         <serverTimestamp>
  ├─ arquivosProcessados: ["laudo_001.docx", "laudo_002.docx", ...]
  ├─ toleranciaUsada:     50
  ├─ pesoConceitoUsado:   0.6
  ├─ dbAnterior:          { ... }   // snapshot completo do dbEDA/dbColono antes da gravação
  └─ alteracoes:          [
       { secao: "esofago", tipo: "atualizacao", nome: "LAA",
         valorAntigo: "...", valorNovo: "..." },
       { secao: "estomago", tipo: "novo", nome: "Erosão plana",
         valor: "..." }
     ]
```

A página do importador deve ter uma aba "Histórico" mostrando os últimos 10 imports, com botão "Reverter este import" que restaura o `dbAnterior`.

## 11. Ordem de implementação

Faseado para permitir testar cada parte antes da próxima.

### Fase 1 — Esqueleto, login e detecção de tipo
- Criar repo `Gerar-Laudo-Importador` no GitHub
- Habilitar GitHub Pages
- Criar `index.html`, `firebase-config.js`, `funcoes_importador.js`
- Implementar tela de login (Firebase Auth)
- Detecção de `?tipo=eda` ou `?tipo=colono` na URL
- Carregar `dbEDA`/`dbColono` do Firestore e exibir contagem de itens por seção
- Carregar `importadorConfig` se existir

**Critério de aceitação**: usuário faz login, vê "dbEDA carregado: 47 itens em 8 seções". Sem importação ainda.

### Fase 2 — Upload e parsing (mammoth.js + decomposição)
- Adicionar mammoth.js via CDN
- Componente de upload (drag-and-drop + seletor)
- Conversão de cada `.docx` para HTML
- Detecção de seções (regra 6.1)
- Decomposição em cláusulas (Camada 1 do pipeline, regra 6.2)
- Mostrar resultado em árvore: por arquivo → por seção → cláusulas extraídas

**Critério de aceitação**: usuário sobe 3 laudos, vê o conteúdo organizado por seção com cláusulas individualizadas.

### Fase 3 — Pipeline de matching conceitual
- Implementar lista de stopwords e termos âncora
- Implementar TF-IDF (Camada 2)
- Implementar Dice coefficient e score de conceito (Camada 3)
- Implementar score final ponderado
- Implementar agregação multi-arquivo por consenso (Camada 4)
- Mostrar scores brutos numa tabela de debug (sem UI bonita ainda)

**Critério de aceitação**: usuário sobe 3 laudos, vê tabela "cláusula → item mais provável → score conceito → score superfície → score final" para cada cláusula.

### Fase 4 — Slider de tolerância e contadores ao vivo
- Implementar slider com escala 0-100
- Implementar fórmulas de limiar derivadas da tolerância (regra 6.6)
- Implementar classificação dinâmica em memória
- Contadores ao vivo que atualizam ao arrastar
- Slider avançado para peso conceito vs texto (oculto por default)
- Salvar valores escolhidos em `importadorConfig`

**Critério de aceitação**: usuário arrasta o slider, vê os contadores mudando suavemente sem trava ou reprocessamento.

### Fase 5 — Tela de revisão completa
- Layout com topo sticky, painel principal e rodapé
- Cada proposta com diff visual, frequência, scores em tooltip
- Botões aceitar/ignorar/editar
- Filtros e ações em massa
- Estado das escolhas mantido em memória

**Critério de aceitação**: usuário pode revisar e marcar cada proposta. Nada gravado ainda.

### Fase 6 — Gravação e histórico
- Modal de confirmação dupla
- Snapshot `dbAnterior`
- Gravação atômica com `set({}, { merge: true })`
- Registro do import em `users/{uid}/imports/{timestampISO}`
- Salvar `importadorConfig` atualizado
- Mensagem de sucesso e botão para voltar ao gerador

**Critério de aceitação**: usuário aplica alterações, recarrega o app gerador, vê os checkboxes refletindo as mudanças.

### Fase 7 — Histórico e reversão
- Aba/página de histórico
- Lista dos últimos 10 imports
- Botão "Reverter este import" com confirmação dupla

**Critério de aceitação**: usuário reverte um import e o `dbEDA`/`dbColono` volta ao estado anterior.

### Fase 8 — Integração nos apps existentes
- Adicionar botão "Importar laudos do Word" no `index.html` do EDA
- Adicionar botão equivalente no Colono
- Cada botão abre `https://ekmogawa.github.io/Gerar-Laudo-Importador/?tipo=eda` (ou colono) em nova aba

**Critério de aceitação**: a partir do app gerador, o usuário consegue ir ao importador, fazer um import, voltar ao gerador e ver o resultado.

## 12. Estrutura de arquivos sugerida

```
Gerar-Laudo-Importador/
├─ index.html              # UI completa
├─ firebase-config.js      # cópia de um dos apps existentes
├─ funcoes_importador.js   # auth, leitura/escrita Firestore, orquestração
├─ parser_word.js          # mammoth.js + detecção de seções + decomposição em cláusulas
├─ matching.js             # TF-IDF, Dice, score híbrido, agregação multi-arquivo
├─ revisao.js              # lógica e UI da tela de revisão + slider
├─ historico.js            # aba de histórico e reversão
├─ stopwords.js            # lista de stopwords portuguesas + termos âncora médicos
├─ estilos.css             # CSS (mesmo visual dos apps existentes)
└─ README.md               # instruções para o usuário final
```

## 13. Critérios de qualidade

- **Sem jQuery** — vanilla JS puro (os apps existentes ainda usam jQuery em parte; este novo projeto começa limpo)
- **Sem dependências NPM** — tudo via CDN ou código próprio
- **Mobile-friendly** — funciona razoavelmente em telas de tablet (uso ocasional em consultório)
- **Mensagens de erro claras** — em português, com sugestão de ação quando possível
- **Comentários no código** — em português, explicando o "porquê" de decisões não-óbvias
- **Console silencioso em produção** — apenas erros reais devem aparecer no console do navegador
- **Performance da Camada 4** — para 20 arquivos × ~30 cláusulas/arquivo × ~50 itens no Firebase = 30.000 comparações. Implementar em loop simples é OK, não precisa otimização exótica, mas evite operações O(n²) desnecessárias dentro do loop.

## 14. Plano B — se o pipeline conceitual não der os resultados esperados

Se na prática o sistema produzir muitos falsos positivos ou negativos:

1. **Primeiro recurso**: ajustar o slider de tolerância e o peso conceito vs superfície. A maioria dos casos resolve só com calibração.
2. **Segundo recurso**: adicionar termos médicos manualmente à lista de termos âncora em `stopwords.js`.
3. **Recurso de regressão**: implementar uma flag oculta `?modo=simples` que desliga a Camada 2 (TF-IDF) e usa apenas Dice puro. Útil para comparar resultados durante debug.
4. **Última opção**: voltar ao algoritmo simples (apenas Dice).

## 15. Próximos passos depois do MVP (não fazem parte da implementação inicial)

- Suporte a outros formatos (`.doc`, `.txt`, `.rtf`)
- Importação de PDF (mais complexo — precisa OCR para PDFs escaneados)
- Estatísticas: quais achados o usuário registra com mais frequência
- Exportar `dbEDA`/`dbColono` para arquivo de backup local
- Sugestão automática de novas seções quando o sistema detecta seções inéditas nos Word files

## 16. Referências para o desenvolvimento

Antes de implementar qualquer função, ler:

- `Gerar-Laudo-Colono/funcoes_colono.js` — funções `carregarDados()` e `salvarDados()` (linhas 256-331) — padrão exato de leitura/escrita Firestore a seguir
- `Gerar-laudo-EDA/funcoes_eda.js` — função `popularCheckboxSection()` — formato do objeto `item` esperado
- `Gerar-Laudo-Colono/dados_colono.js` — `DB_PADRAO` — mostra a estrutura completa de `dbColono`
- mammoth.js — https://github.com/mwilliamson/mammoth.js — método `mammoth.convertToHtml()` é o que usaremos
- TF-IDF — referência didática: https://en.wikipedia.org/wiki/Tf%E2%80%93idf (implementação simples, não precisa biblioteca)
- Dice coefficient — referência didática: https://en.wikipedia.org/wiki/S%C3%B8rensen%E2%80%93Dice_coefficient
