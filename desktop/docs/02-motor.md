# 2. O modelo de IA no desktop

## O que é o "shim"

O app BOAR foi escrito para Android. O código que conversa com o modelo de IA
(`src/inference/LlamaEngine.ts` e `src/rag/embed.ts`) importa uma biblioteca chamada
`llama.rn`, que só existe no celular: ela é código nativo (C++) embutido no app Android.

No desktop essa biblioteca não existe. Em vez de reescrever o motor do app, a gente
coloca no lugar dela um **shim** (calço): `desktop/src/shims/llama.rn.ts`. Ele tem os
mesmos nomes e o mesmo formato que o `llama.rn` (`initLlama`, `LlamaContext.completion`,
`stopCompletion`, `tokenize`, `embedding`, `release`, `loadLlamaModelInfo`,
`getBackendDevicesInfo`). Quando o app é empacotado para desktop
(`BOAR_TARGET=desktop`), o `metro.config.js` troca `llama.rn` por esse arquivo. O motor
do app não percebe a diferença e não precisou de nenhuma alteração.

## Por que o modelo roda no processo principal e não na página

Um app Electron tem duas partes:

- **a página (renderer)**: é um navegador (Chromium) mostrando a interface. Por
  segurança, ela não acessa arquivos nem carrega código nativo;
- **o processo principal (main)**: é Node.js, com acesso ao disco, à GPU e a módulos
  nativos.

O modelo precisa ler um arquivo de ~1 GB do disco e usar a placa de vídeo, então ele roda
no main, usando a biblioteca `node-llama-cpp` (o mesmo llama.cpp que o `llama.rn` usa
no celular). A página só pede as coisas. Bônus: enquanto o modelo trabalha, a interface
não trava, porque o trabalho pesado está em outro processo.

O código fica em três arquivos:

- `desktop/src/shims/llama.rn.ts`: lado da página, só repassa pedidos;
- `desktop/src/main/handlers/llama.rn.ts`: liga cada "canal" a uma função;
- `desktop/src/main/llama/engine.ts`: a lógica real com `node-llama-cpp`.

Por segurança, o main só abre modelos que estão dentro da pasta de dados do app ou de
uma pasta de modelos indicada em `BOAR_MODELS_DIR`. Qualquer outro caminho é recusado.

## Como funciona o streaming (as palavras chegando aos poucos)

A página e o main conversam por IPC (troca de mensagens entre processos), através de
`window.boarNative`:

1. A página chama `context.completion(params, callback)`. O shim cria um **id de
   pedido** (ex.: `lq3k-7`), começa a escutar o evento `llama.rn:token` e manda
   `invoke("llama.rn:completion", contextId, idDoPedido, params)`.
2. O main gera o texto. A cada pedaço, envia `llama.rn:token` com o id do pedido e
   `{ token: "..." }`. O shim entrega ao callback só os eventos com o seu id, então
   dois pedidos ao mesmo tempo não se misturam.
3. Ao terminar, o `invoke` responde com o resultado completo (texto, contagens de
   tokens, tempos), no mesmo formato do `llama.rn`. O shim para de escutar.

Para parar (`stopCompletion`), o main cancela a geração, e a promessa termina
normalmente com o texto gerado até ali, como no celular. O progresso do carregamento
funciona do mesmo jeito, com o evento `llama.rn:progress` (0 a 100).

Tudo que passa pelo IPC precisa ser dado simples (texto, número, lista, objeto). Funções
e classes não atravessam, por isso o callback fica na página e só os pedaços de texto
viajam.

## Diferenças em relação ao llama.rn no Android

- **GPU**: no celular o app pede `n_gpu_layers: 0` (só CPU). No desktop esse valor é
  ignorado: o `node-llama-cpp` escolhe sozinho (CUDA ou Vulkan; nesta máquina usou
  Vulkan na GTX 1650). Se a GPU falhar, ele tenta de novo na CPU. Só uma lista de
  dispositivos explicitamente de CPU (a nova tentativa do `initFallback`) força CPU.
- **Template de chat**: com `messages` + `jinja`, o modelo usa o próprio template do
  arquivo GGUF (o `node-llama-cpp` escolhe um "chat wrapper" equivalente a ele).
- **`n_predict: 0`** (pré-carregar o começo do prompt): o `node-llama-cpp` não tem esse
  modo, então gera 1 token e o descarta. O efeito para o app é o mesmo: o prefixo fica no
  cache e a pergunta seguinte reaproveita.
- **Orçamento de raciocínio**: `thinking_budget_tokens` vira o limite de tokens de
  "pensamento" do `node-llama-cpp`. A mensagem `thinking_budget_message` não tem
  equivalente e é ignorada.
- **Tempos e cache**: `tokens_cached` e os tempos são medidos de fora (um ou dois tokens
  de diferença do llama.rn). São usados só para estatísticas.
- **Não implementado** (o app não usa): sessões salvas em arquivo, imagens/áudio,
  tool calls, rerank, modo paralelo, `getFormattedChat`, `bench`.
- Os vetores de embedding são normalizados (tamanho 1), como o padrão do llama.cpp.
