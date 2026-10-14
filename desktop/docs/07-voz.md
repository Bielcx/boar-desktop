# 7. Voz offline (whisper.cpp)

No Android, o botão de microfone usa o reconhecedor de fala do sistema (`modules/voice-input`). No desktop isso não
existe, então antes o botão dizia "indisponível". Agora a voz funciona **sem internet**, com o whisper.cpp rodando no
próprio computador.

## Como o app acha o módulo de voz

`src/voice/VoiceInput.ts` (código compartilhado com o Android) não importa o pacote `voice-input`: ele chama
`requireOptionalNativeModule("VoiceInput")` do `expo-modules-core`. Na web essa função só lê o registro
`globalThis.expo.modules` quando o app roda dentro de um webview de "DOM component" (`globalThis.ExpoDomWebView`), e
ligar essa flag mudaria o caminho de outros pacotes (o `expo-sqlite`, por exemplo). Por isso a troca é no Metro:

- `metro.config.js`: quando um arquivo **de `src/`** importa `expo-modules-core`, recebe
  `desktop/src/shims/expo-modules-core.ts`; bibliotecas e o próprio shim recebem o pacote de verdade.
- O shim reexporta tudo do pacote real e só muda `requireOptionalNativeModule`: para `"VoiceInput"` devolve
  `desktop/src/shims/voice-input.ts`. Nenhuma linha de `src/` mudou.

## O caminho do áudio

1. Toque no microfone → `VoiceInput.ts` pergunta `getRecognitionMode()` → `"on-device"` (o binding carrega).
   A política (`voicePolicy.ts`) libera, como no Android com reconhecimento no aparelho.
2. `startListening`: `getUserMedia` (só áudio) → `AudioContext` a 16 kHz → blocos de amostras guardados na memória.
   O `main.ts` libera a permissão `media` **só** para áudio, só para o quadro principal da página do app.
3. Detector simples de fala por volume (RMS): ao ouvir voz manda `onSpeechStart`; depois de **1,2 s** de silêncio
   (ou 30 s de gravação) para sozinho, como o Android. Sem voz em 8 s → `onError` código `6` ("No speech input").
4. A cada 1,5 s, se não houver outra em andamento, transcreve o que já foi gravado → `onPartialResults`.
5. No fim: `onSpeechEnd`, converte para PCM 16 bits mono 16 kHz e chama `voice-input:transcribe` no main.
   O main (`handlers/voice-input.ts`) roda o whisper (`@fugood/whisper.node`, **só CPU**: a GPU fica para o LLM),
   tira marcas como `[BLANK_AUDIO]` e devolve o texto → `onResults` (ou `onError` `7` se veio vazio).
6. Idioma: o do app (`i18n.language`), `pt` ou `en`.

Os números de calibragem (volume de fala, tempo de silêncio) estão no topo de `shims/voice-input.ts`.

## O modelo

`ggml-base-q5_1.bin` do repositório oficial [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)
(licença MIT), multilíngue, 59.707.625 bytes, sha256
`422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`. Fica em
`<userData>/documents/models/whisper-ggml-base-q5_1.bin`.

Como o usuário obtém: **no primeiro toque no microfone**. O app mostra uma confirmação ("o modelo de voz, 60 MB, não
está instalado; baixar do Hugging Face?"). Se aceitar, baixa pelo mesmo downloader do app (só https), confere o sha256,
e avisa "toque de novo para falar" (não começa a gravar sozinho depois de um download longo). Se recusar, nada é
baixado. No build `offline` (sem rede) a mensagem pede para colocar o arquivo na pasta de modelos.

Por que não no catálogo (`src/models/manifest.ts`): o catálogo é do Android também, e lá a voz não usa whisper;
um tipo novo de asset mexeria na tela de setup e nos tiers. Fica como proposta se o Android ganhar whisper.

## Testes

- `test/voice-input.test.ts`: o handler pelo IPC de teste, transcrevendo `test/fixtures/voice-en.wav` ("Where can I
  find clean drinking water?") e `voice-pt.wav` ("Como eu purifico a água na floresta?"). As fixtures foram geradas
  com a voz do Windows (PowerShell `System.Speech`, vozes David e Maria, 16 kHz mono 16 bits, 0,5 s de silêncio antes e
  2,5 s depois). Precisa de `ggml-base-q5_1.bin` em `BOAR_TEST_MODELS_DIR`.
- `e2e/voice.spec.ts`: o app de verdade com o microfone falso do Chromium
  (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=voice-en.wav`): toca no microfone e espera o
  texto na caixa do chat. `e2e/tour.spec.ts` confere a pergunta de download (cancelada).
- `BOAR_E2E_EXE=release/win-unpacked/BOAR.exe` roda os e2e no app empacotado.

## Pacote

Entra `@fugood/whisper.node` (JS, ~15 KB) e `@fugood/node-whisper-win32-x64` (`index.node`, 2,76 MB, fora do asar
como o node-llama-cpp). As variantes CUDA/Vulkan/WASM do pacote não estão instaladas nem empacotadas. O modelo não vai
no instalador.

## Limites conhecidos

- Durante o download do modelo não há barra de progresso (só a animação do botão).
- Os textos "Android SpeechRecognizer" na tela de configurações de voz (`src/i18n`) continuam com o texto do Android.
- O detector de fala é por volume: em ambiente barulhento pode não parar sozinho (o toque no botão para).
