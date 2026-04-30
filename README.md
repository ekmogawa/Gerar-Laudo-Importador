# Gerar-Laudo-Importador

Importa laudos prontos em Word (.docx) e atualiza o banco pessoal de checkboxes do usuário no Firebase, refinando o texto dos itens existentes e criando itens novos a partir do que aparece nos laudos.

Funciona em duas variantes — EDA e Colonoscopia — selecionadas pela URL:

- `?tipo=eda`     — atualiza `users/{uid}.dbEDA`
- `?tipo=colono`  — atualiza `users/{uid}.dbColono`

Compartilha o mesmo projeto Firebase e os mesmos usuários dos apps:
- https://ekmogawa.github.io/Gerar-laudo-EDA/
- https://ekmogawa.github.io/Gerar-Laudo-Colono/

## Status

- [x] Fase 1 — Esqueleto, login e detecção de tipo
- [x] Fase 2 — Upload e parsing (mammoth.js + decomposição em cláusulas)
- [x] Fase 3 — Pipeline de matching conceitual (TF-IDF + Dice + consenso)
  - **invertido**: para cada item do banco, busca melhor janela de 1-4 sentenças na seção correspondente; sentenças não cobertas viram candidatos a item novo
- [x] Fase 4 — Slider de tolerância e contadores ao vivo
- [x] Fase 5 — Tela de revisão completa
- [x] Fase 6 — Gravação e snapshot
- [x] Fase 7 — Histórico e reversão
- [x] Fase 8 — Integração nos apps geradores

## Como rodar localmente

Abra `index.html?tipo=eda` ou `index.html?tipo=colono` direto no navegador.
Não há build, servidor ou npm — tudo é HTML/JS estático com Firebase via CDN.

## Smoke-test do parser

Abra `test_parser.html` no navegador para rodar 8 casos de teste sintéticos
que validam a detecção de seções, classificação por âncoras e decomposição
em cláusulas, sem precisar de arquivos `.docx` reais. Cada caso mostra
**OK** ou **FALHA** com a entrada e a saída esperada.

## Arquivos

| Arquivo | Papel |
|---|---|
| `index.html` | UI completa |
| `firebase-config.js` | Credenciais públicas do projeto Firebase |
| `funcoes_importador.js` | Auth, leitura/escrita Firestore, orquestração da UI |
| `parser_word.js` | Conversão .docx, detecção de seções, decomposição em cláusulas |
| `matching.js` | TF-IDF, Dice, score híbrido, consenso multi-arquivo |
| `backup.js` | 4 slots de backup (original imutável + 3 datados) |
| `estilos.css` | Visual |

## Inicialização e backups

### Seed no primeiro acesso

Quando um usuário abre o importador pela primeira vez para um tipo
(EDA ou Colono) e ainda não tem `dbEDA`/`dbColono`, o sistema:

1. Lê o banco curado pelo admin de `visitante/publico` (espelho mantido
   por `ekmogawa@gmail.com`).
2. Salva esse snapshot como o `dbEDA`/`dbColono` do próprio usuário.
3. Auto-cria o backup `original` com o mesmo snapshot.

A partir desse ponto o banco é DELE — **não há nova importação do
admin posteriormente.** O original captura o estado de criação da conta
e serve como rede de segurança permanente.

### 4 slots de backup por especialidade

- **Original** — definido no primeiro acesso (cópia do admin naquele momento).
  Imutável daí em diante.
- **Slot 1, 2, 3** — checkpoints manuais do banco do próprio usuário
  (salvar / restaurar / apagar).

Armazenados em `users/{uid}/backups/{tipo}_{slot}` (subcollection — não impacta
o tamanho do doc principal). Cada doc contém o snapshot completo + timestamp
+ contagem de itens.
