# 9. Biblioteca para outros apps (servidor MCP)

## A ideia em uma frase

Outros apps de IA no mesmo computador (Claude Desktop, Cursor, qualquer cliente MCP) podem **buscar na biblioteca do
BOAR** e receber trechos com a fonte. O BOAR não responde nada com modelo de linguagem aqui: só faz a busca do próprio
app (`retrieve()` de `src/rag/retrieve.ts`, que põe os documentos do usuário primeiro) e devolve o que achou. Quem
escreve a resposta é o modelo do outro app.

MCP (Model Context Protocol) é um protocolo aberto: o cliente lança um programa e conversa com ele por mensagens
JSON-RPC, uma por linha, na entrada e saída padrão (stdio). **Nenhuma porta de rede é aberta.**

## Como ligar

Configurações > **Compartilhar minha biblioteca (MCP)** (só no desktop; no Android a seção não aparece):

1. Ligue "Compartilhar minha biblioteca com outros apps (MCP)". Vem **desligado**.
2. Escolha as coleções visíveis. Na primeira vez que liga, as coleções que já existem vêm marcadas (a lista fica logo
   abaixo). Coleções importadas depois **não** entram sozinhas. "Biblioteca embutida" são os artigos que vêm com o app
   e os pacotes baixados (Wikipedia...): texto público, marcado por padrão.
3. "Copiar configuração para o Claude Desktop" copia o trecho certo para colar em `claude_desktop_config.json`
   (Claude Desktop > Settings > Developer > Edit Config) e reinicie o Claude Desktop:

```json
{
  "mcpServers": {
    "boar": {
      "command": "C:\\Users\\voce\\AppData\\Local\\Programs\\BOAR\\BOAR.exe",
      "args": ["C:\\Users\\voce\\AppData\\Local\\Programs\\BOAR\\resources\\app.asar\\dist\\mcp\\server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "BOAR_USER_DATA": "C:\\Users\\voce\\AppData\\Roaming\\BOAR" }
    }
  }
}
```

Se o arquivo já tem outros servidores, junte só a entrada `"boar"` dentro de `mcpServers`. Cursor e outros clientes
usam o mesmo formato (`command`, `args`, `env`).

O interruptor e a lista valem **na hora**: o servidor relê `<userData>/mcp.json` a cada chamada. Desligado, toda busca
responde com o erro "Library sharing is off..." e nada da biblioteca.

## As ferramentas

| Ferramenta | Entrada | Saída |
|---|---|---|
| `list_collections` | nada | as coleções compartilhadas: `id`, `name`, `docCount`, `kind` (`personal` ou `builtin`) |
| `search_library` | `query` (texto, até 2000 caracteres), `k` (1 a 20, padrão 6), `collections` (ids ou nomes de `list_collections`, opcional) | até `k` trechos: `title`, `source` (nome do arquivo importado, ou "Wikipedia — URL"), `collection`, `similarity` (cosseno com a pergunta, 0 a 1), `text` |

A saída vai como texto (JSON legível, para o modelo) e como `structuredContent` (o mesmo, para programas). Erros de uso
(coleção que não está compartilhada, `k` fora da faixa, compartilhamento desligado) voltam como resultado com
`isError: true`, que o modelo do cliente lê e explica; erros de protocolo são erros JSON-RPC.

## Como funciona por dentro

- `src/mcp/protocol.ts`: o pedaço do MCP que o BOAR usa, escrito à mão, sem dependência: `initialize` (responde a
  versão pedida se for 2025-06-18, 2025-03-26 ou 2024-11-05, senão a mais nova), `notifications/initialized` (e
  qualquer notificação: sem resposta), `ping`, `tools/list`, `tools/call`. Sem resources, prompts ou sampling.
- `src/mcp/server.ts`: o motor do app, o mesmo `src/` do Android, sobre os shims do desktop ligados aos handlers do
  main pelo `loopback` (`src/testing/loopback.ts`), do jeito que `bench/docs.run.ts` já roda. Carrega o modelo de
  embedding que a biblioteca usou (o ativo em `settings.json`) na primeira chamada (~1 s).
- `scripts/build-mcp.mjs` empacota isso em `dist/mcp/server.js` (rolldown, que já vem com o vitest na raiz; roda no
  `npm run build:main`). Os pacotes nativos viram os shims pelo mesmo `shared/packages.json` que o Metro usa.
- **O cliente roda o próprio `BOAR.exe` como Node** (`ELECTRON_RUN_AS_NODE=1`) sobre esse arquivo. Por que não
  `BOAR.exe --mcp`: no Windows o processo principal do Electron (um app de janela) não recebe a entrada padrão; ela
  chega fechada. Como Node, o mesmo executável lê o `server.js` de dentro do `app.asar` e acha o `node-llama-cpp`
  instalado com o app. Se um dia o pacote desligar o fusível `RunAsNode` do Electron, isto para de funcionar.
- Logs só na saída de erro (stderr): o servidor redireciona `console.*` e qualquer escrita em `process.stdout`, porque
  uma linha a mais no stdout quebraria o protocolo.

## Com o app aberto ao mesmo tempo

Funciona, e o app não precisa estar aberto. O banco é SQLite em modo WAL: vários leitores e um escritor convivem. O
servidor abre o banco **só para leitura** (`readOnly` do `node:sqlite`) e vê o que o app grava (um documento importado
aparece na próxima busca). As migrações do `src/rag/db.ts` (`CREATE ... IF NOT EXISTS`) não fazem nada num banco que
já existe, então passam numa conexão de leitura. Se o app nunca rodou (sem banco), a busca diz para abrir o BOAR e
terminar a configuração.

O modelo de embedding é pequeno (bge-small, ~35 MB) e carrega no processo do servidor; com o app aberto, os dois
carregam a própria cópia.

## Segurança

Complementa o `06-seguranca.md`. Quem fala com o servidor é outro programa do próprio usuário, mas o texto que chega
vem de um modelo de linguagem, então é tratado como não confiável:

- **Somente leitura, em duas camadas.** O banco abre com `readOnly` (o SQLite recusa qualquer escrita), e o servidor
  só registra os canais de leitura (`READ_CHANNELS` em `server.ts`): abrir/consultar o banco, ler arquivo, carregar o
  embedding. Gravar, apagar, mover ou baixar arquivo nem existe nesse processo.
- **Só stdio.** Nenhuma porta, nenhum socket. Só o programa que lançou o servidor fala com ele.
- **Só as coleções permitidas.** O filtro vai no SQL da busca (`RetrievalScope` em `retrieve.ts`): uma coleção não
  marcada não entra nem na busca por palavras nem na por vetor, e os pacotes da Wikipedia só entram com "Biblioteca
  embutida" marcada. Pedir uma coleção não compartilhada dá erro sem dizer se ela existe.
- **Nada de caminho vindo do cliente.** As ferramentas só recebem texto de busca, um número e nomes de coleção. A pasta
  de dados vem da linha de comando que o próprio usuário configurou (`BOAR_USER_DATA`), e todo arquivo continua
  passando pelo `safePath` dos handlers.
- **Limites:** pergunta até 2000 caracteres, até 20 trechos por chamada.
- A configuração fica em `<userData>/mcp.json`, fora das pastas que a página do app enxerga como arquivo; a página só
  muda pelos canais `library-share:get/set`, como qualquer outra configuração.
- **O que sai do computador:** o BOAR não manda nada para a rede, mas o app cliente manda os trechos que ler para o
  modelo dele, que pode ser online (o Claude Desktop usa a nuvem da Anthropic). Por isso desligado por padrão, coleção
  nova fora da lista, e o aviso na tela.

## Testes

- `test/mcp.test.ts`, parte 1: o protocolo mensagem a mensagem (initialize, notificação sem resposta, ping, tools/list,
  tools/call, erro de ferramenta, JSON inválido, método desconhecido) e a leitura do `mcp.json` (qualquer coisa
  estranha vira "desligado").
- Parte 2 (precisa de `embedding.gguf` em `BOAR_TEST_MODELS_DIR`): importa dois documentos como duas coleções com o
  importador do app, gera o `dist/mcp/server.js`, lança `node dist/mcp/server.js` como processo filho e faz
  initialize → tools/list → tools/call. Confere: desligado dá erro; ligado, o documento compartilhado vem com a fonte
  (`grandma-recipes.txt`); o não compartilhado nunca aparece e pedir por ele dá erro; marcar na hora já vale; o banco e
  o WAL ficam idênticos (hash) depois das buscas.
- Cliente real: o SDK oficial (`@modelcontextprotocol/sdk` 1.30, `Client` + `StdioClientTransport`) conectou no
  `electron.exe` com `ELECTRON_RUN_AS_NODE=1`, listou as ferramentas, fez ping e buscou ("Como funcionam as vacinas?" →
  Vaccine, Wikipedia).

```
BOAR_TEST_MODELS_DIR=C:/Users/bielc/Dev/boar-shared-models npx vitest run test/mcp.test.ts   (em desktop/)
```

## O que ficou de fora

- Resources, prompts, notificação de lista mudada, cancelamento: o cliente só precisa das duas ferramentas.
- Transporte HTTP: abriria porta de rede.
- Escolher coleções por documento (é por coleção, como no app).
- Modelos de embedding baixados do Hugging Face (fora do catálogo): o servidor usa o do catálogo marcado como ativo, ou
  o padrão.
