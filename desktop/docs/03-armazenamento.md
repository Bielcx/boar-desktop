# 3. Armazenamento no desktop (SQLite, arquivos, hash, RAM, PDF)

## A ideia em uma frase

No Android, o app chama módulos nativos (expo-sqlite, expo-file-system...). No desktop, a interface roda numa página
web dentro do Electron (o "renderer"), e página web não tem acesso a disco. Então cada módulo nativo virou duas metades:

- **shim** (`desktop/src/shims/<pacote>.ts`): roda na página e imita a API do pacote original, com os mesmos nomes. Ele
  não faz nada sozinho: manda uma mensagem pelo `window.boarNative.invoke(...)`.
- **handler** (`desktop/src/main/handlers/<pacote>.ts`): roda no processo principal (o "main", que é Node de verdade),
  recebe a mensagem e faz o trabalho com `node:sqlite`, `fs`, `crypto`, `fetch`.

O código do app em `src/` não muda nada: o Metro troca o import do pacote pelo shim quando `BOAR_TARGET=desktop`.

## O que cada shim faz

| Pacote | O que o app usa | No desktop |
|---|---|---|
| `expo-sqlite` | `openDatabaseAsync`, `execAsync`, `runAsync`, `getAllAsync`, `getFirstAsync`, `withTransactionAsync`, `closeAsync` | Banco aberto no main com `node:sqlite` (FTS5 incluso). O renderer só guarda um número (o id da conexão). |
| `expo-file-system/legacy` | `documentDirectory`, `cacheDirectory`, ler/gravar texto, `getInfoAsync`, apagar, criar pasta, listar, mover, copiar, espaço livre, `createDownloadResumable` | `fs/promises` no main. Download com `fetch` gravando direto no disco, com progresso, pausa e retomada. |
| `expo-file-system` | só a classe `File`, num caminho de reserva do `fileHash.ts` que nunca roda no desktop | Lança erro claro se alguém usar. |
| `file-hash` | SHA-256 de arquivo, copiar e calcular hash na mesma passada, tamanho, cancelar | Leitura em blocos de 4 MB com `crypto`; nunca carrega o arquivo inteiro na memória. |
| `ram-monitor` | memória do processo, RAM total e disponível, info de CPU | `process.memoryUsage()` e `os` no main (é lá que os modelos rodam). |
| `expo-pdf-text-extract` | `extractText` | Lê o texto com o **pdf.js** (`pdfjs-dist`, da Mozilla, licença Apache-2.0) numa *worker thread* do main (`handlers/pdf-worker.ts`), para um PDF grande não travar a janela. Limites: 100 MB, 2000 páginas, 2 min (depois disso a worker é encerrada). Erros com os mesmos códigos do módulo nativo (`PASSWORD_REQUIRED`, `CORRUPT_PDF`...), que o shim devolve em `e.code`. Só texto embutido: PDF escaneado (imagem) vira texto vazio, igual no Android. |

## Por que o armazenamento fica no main

1. A página não acessa disco; só o main acessa.
2. Segurança: se a página for comprometida (ex.: um texto malicioso que vira código), ela ainda só consegue pedir as
   operações que o main aceita, e só dentro da pasta de dados do app.
3. Os modelos (GGUF) rodam no main, então os arquivos precisam estar onde ele enxerga.

## Regra de segurança dos caminhos

Todo caminho que chega da página é uma URI `file://`. Antes de qualquer operação, `desktop/src/main/storage/safePath.ts`:

1. converte a URI em caminho com `fileURLToPath` (isso também resolve `%2e%2e`, que é `..` disfarçado);
2. resolve o caminho absoluto (some com os `..`);
3. confere que ele fica dentro de `dataDir` (a pasta de dados do app);
4. segue os links simbólicos da parte do caminho que já existe e confere de novo, para que um atalho dentro da pasta
   apontando para fora não passe.

Se falhar, a operação é recusada com erro. Downloads também só aceitam `https://` (os testes ligam `http` local pela
variável `BOAR_ALLOW_HTTP_DOWNLOADS=1`).

## Transações atravessando o IPC

`withTransactionAsync(tarefa)` roda a tarefa na página, mas cada consulta dela é uma mensagem separada para o main. O
shim manda `BEGIN`, roda a tarefa, e manda `COMMIT` (ou `ROLLBACK` se ela der erro). Pontos importantes:

- No main, cada mensagem é uma chamada síncrona do `node:sqlite`, então duas consultas nunca se misturam no meio.
- Duas transações ao mesmo tempo na mesma conexão entram numa fila no shim: a segunda espera a primeira acabar (no
  Android ela falharia). O app já serializa as escritas em `src/rag/db.ts`, então isso é só uma rede de proteção.
- Igual ao Android: uma consulta feita por outra parte do app enquanto a transação está aberta cai dentro dela.
- Se a página recarregar no meio de uma transação, o main desfaz (`ROLLBACK`) e fecha as conexões que aquela página
  abriu, para o banco não ficar travado.

## RAM: valores síncronos sobre um canal assíncrono

O `ram-monitor` original responde na hora (síncrono), mas IPC sempre é assíncrono. O shim guarda o último valor que veio
do main e, quando o valor tem mais de 0,5 s, pede um novo em segundo plano. Na prática o número atrasa uma leitura. Nos
primeiros milissegundos, antes da primeira resposta, tudo vale 0 (o mesmo "indisponível" do módulo original).

## O que ficou de fora

- **Classe `File`** do expo-file-system: a API dela é síncrona; só seria feita com `sendSync` se algo precisar.
- APIs que o app não usa (`prepareAsync`, versões síncronas do SQLite, `cancelAsync` de download, `md5` no
  `getInfoAsync`, leitura parcial com `position`/`length`).
- RAM: no desktop não existe PSS; o campo `totalPssBytes` repete o RSS do processo main.
- Arquivos escolhidos pelo usuário fora da pasta de dados (importar documento/modelo) só funcionam se o seletor de
  arquivos copiar para o `cacheDirectory` antes (o expo-document-picker faz isso por padrão; veja 01-casca.md).

## Como testar

```
npx vitest run desktop/test
```

`desktop/test/shims.test.ts` testa cada shim contra o handler real (inclusive tentativas de sair da pasta e busca FTS5).
`desktop/test/appEngine.test.ts` roda o código do próprio app (`src/rag` e `src/models`) sobre os shims: indexa o corpus
de 300 artigos, faz uma busca real, baixa um "modelo" de um servidor local com a conexão caindo no meio e retomando, e
confere o SHA-256. Só o modelo de embedding é falso (o llama.rn tem o próprio teste, veja 02-motor.md).
