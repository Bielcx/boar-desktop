# 10. Servidor de API local (com tokens)

## A ideia em uma frase

Programas no mesmo computador (scripts, Open WebUI, qualquer cliente da API da OpenAI) podem **perguntar ao BOAR e
buscar na biblioteca por HTTP**, só com um token criado no app. É o que o LM Studio faz no servidor dele, mas sem as
brechas: só escuta em `127.0.0.1`, recusa páginas da web, guarda o token só como hash, tem validade e limite por
minuto, e para de responder quando o BOAR está trancado com PIN.

## Como ligar

Configurações > **Servidor de API local** (só no desktop):

1. Ligue o servidor. Vem **desligado**. A porta padrão é `41414` (dá para trocar; precisa estar entre 1024 e 65535).
2. Crie um token: dê um nome e escolha a validade (30, 90 ou 365 dias, ou sem validade). O token aparece **uma vez
   só**; copie na hora. Depois a tela mostra só o começo e o fim (`boar_Ab12…wxyz`), o último uso e a validade.
3. "Revogar" apaga o token na hora: o próximo pedido com ele recebe 401.

```bash
curl http://127.0.0.1:41414/v1/chat/completions \
  -H "Authorization: Bearer boar_..." \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is a black hole?"}]}'
```

Com o SDK da OpenAI: `new OpenAI({ baseURL: "http://127.0.0.1:41414/v1", apiKey: "boar_..." })`. Testado com o SDK
oficial de Node (4.104): `models.list`, `chat.completions.create`, com e sem `stream`, e chave errada dando 401.

## Rotas

| rota | o que faz |
|---|---|
| `GET /v1/models` | o modelo ativo do app (`data[0].id`) |
| `POST /v1/chat/completions` | a resposta do BOAR, no formato da OpenAI. `stream: true` manda server-sent events terminando em `[DONE]`. As fontes vêm em `boar_sources` (título, fonte, coleção, similaridade, texto). |
| `POST /v1/library/search` | `{ "query": "...", "k": 6 }` → os trechos da biblioteca, como o MCP (`k` de 1 a 20) |

Sobre o chat:
- A última mensagem do usuário é a pergunta; as anteriores (usuário e assistente, até 6) são o histórico.
- **A mensagem de sistema do cliente é ignorada:** o BOAR responde do jeito dele, com fontes, na personalidade
  escolhida no app.
- `max_tokens` vale até 2048; sem ele, vale o tamanho de resposta do app.
- Nem toda resposta sai token a token: recusa e cartões chegam prontos no fim. No streaming, se nada foi transmitido,
  o texto final vai num pedaço só. Se a checagem de fontes mudou o texto já transmitido, o final vem em `boar_text`
  no último evento.

## Erros

No formato da OpenAI (`{ "error": { "message", "type", "code" } }`):

| status | quando |
|---|---|
| 401 | sem token, token inválido, revogado ou vencido (`WWW-Authenticate: Bearer`) |
| 403 | `Host` diferente de `127.0.0.1:<porta>` / `localhost:<porta>`, ou pedido com `Origin` (página da web) |
| 404 | rota desconhecida |
| 413 / 415 | corpo acima de 1 MB / corpo que não é JSON |
| 423 | o BOAR está trancado com PIN |
| 429 | mais de 60 pedidos no último minuto com esse token (`Retry-After`) |
| 503 | a janela do app ainda não subiu (ele pode ficar na bandeja) |
| 504 | sem resposta em 5 minutos |

## Como funciona por dentro

- **Processo principal** (`src/main/handlers/api-server.ts`): `node:http` em `127.0.0.1`. Ele cuida da porta:
  confere `Host` e `Origin`, compara o hash do token com todos os guardados em tempo constante, olha a validade e o
  limite, e lê o corpo. Só então repassa o pedido para a página, por IPC (`api-server:request`).
- **Página** (`src/services/apiServer.ts`): roda a busca (`retrieve`) ou a resposta (`answer()` de
  `src/routing/answerService.ts`) com o modelo que o app já tem carregado, então não sobe um segundo modelo na
  memória. A geração entra na fila do `LlamaEngine`: um pedido da API espera o chat terminar, e vice-versa.
- **Arquivos:** `<userData>/api-server.json` (ligado, porta) e `<userData>/api-tokens.json` (nome, hash SHA-256,
  dica, datas). O token em si nunca é gravado.
- **Bloqueio:** se o BOAR recarregar a página, os pedidos em andamento falham e os novos recebem 503 até ela voltar.

## Limites e próximos passos

- Por enquanto, todo token lê a biblioteca toda. O próximo passo (fase 3) é limitar cada token a algumas coleções e
  a algumas rotas.
- Ainda não há registro de "quem leu o quê" por token (fase 4); hoje só o último uso.
- Só este computador. Rede local fica para a fase 5, e só com token obrigatório.
- O botão Parar do chat também cancela uma geração da API que esteja na fila.
- Testes: `test/api-server.test.ts` (a porta por HTTP de verdade, com uma página de mentira) e `e2e/api.spec.ts`
  (token criado no app; modelos, busca, resposta e streaming por `fetch`; revogar dá 401).
