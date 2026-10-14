# 1. A casca do app desktop

## A ideia em uma frase

O BOAR é um app Android feito em React Native. O Expo consegue gerar uma versão **web** desse mesmo
código. O app desktop é essa versão web aberta dentro de uma janela do **Electron**, e as partes que
no celular dependem de código nativo (rodar o modelo, banco SQLite, arquivos) são feitas pelo Node.js,
que roda junto com o Electron.

## As três peças do Electron

Um app Electron tem processos separados, e entender isso explica quase todo o resto:

- **Main (processo principal)** – `src/main/main.ts`. É um programa Node.js comum: pode ler e escrever
  arquivos, abrir diálogos do sistema, carregar o llama.cpp. Ele cria a janela e decide o que ela mostra.
  Não tem tela.
- **Renderer (a página)** – é a janela em si, um Chromium mostrando o app web do BOAR. Tudo o que você vê
  roda aqui. Por segurança, ele **não** tem acesso ao Node: não abre arquivo, não executa programa.
- **Preload** – `src/main/preload.ts`. Um script pequeno que roda dentro da janela, antes da página, e é a
  única ponte entre os dois. Ele pendura um objeto `window.boarNative` com poucas funções
  (`invoke`, `on`, `platform`, `dirs`). Quando o app chama, por exemplo,
  `boarNative.invoke("expo-sharing:shareAsync", arquivo)`, a mensagem vai para o main, que faz o trabalho e
  devolve a resposta.

No meio disso ficam os **shims** (`src/shims/`): arquivos que fingem ser os pacotes nativos
(`expo-sharing`, `expo-document-picker`...). Quando o app é empacotado com `BOAR_TARGET=desktop`, o Metro
troca o pacote original pelo shim, e o shim repassa a chamada para o main. Assim o código do app em `src/`
não muda nada.

## Por que tanta separação (contextIsolation, sandbox)

Se a página tivesse acesso direto ao Node, qualquer bug que deixasse entrar um texto malicioso (um PDF
importado, um link, uma resposta do modelo renderizada) poderia apagar arquivos do computador. Por isso:

- `nodeIntegration: false` – a página não enxerga o Node.
- `contextIsolation: true` – o preload e a página vivem em "mundos" JavaScript separados; a página só vê o
  que o preload expõe de propósito.
- `sandbox: true` – a janela roda com as mesmas restrições de uma aba do Chrome.
- O preload só aceita canais no formato `<pacote>:<método>` de pacotes conhecidos, e o main recusa qualquer
  caminho de arquivo fora da pasta de dados do app (`storage/safePath.ts`).
- Links para outros sites não abrem dentro do app: vão para o navegador do sistema.

## Por que um protocolo próprio (`app://`)

Em produção, o app web é um conjunto de arquivos na pasta `web-dist/`. O jeito óbvio seria abrir com
`file://.../index.html`, mas o Expo gera caminhos absolutos como `/_expo/static/js/...`. Em `file://`,
"`/`" é a raiz do disco (`C:\`), então nada carregaria. O main registra o esquema `app://boar/`, que serve
os arquivos de `web-dist/` como se fosse um site: `/` passa a ser a pasta do app. Em desenvolvimento não
precisa disso: a janela abre direto o servidor do Expo (`http://localhost:8081`), com recarga ao salvar.

## Onde ficam os dados

O main usa a pasta de dados do usuário que o sistema reserva para o app (no Windows,
`%APPDATA%\BOAR`), com `documents/` (modelos, banco, configurações) e `app-cache/` (não `cache/`: num disco que não diferencia maiúsculas seria a pasta `Cache` do próprio Chromium). Esses caminhos são passados
para a janela já na abertura, porque o app lê `documentDirectory` como uma constante logo ao carregar.

## O que o desktop faz diferente do celular

- **Localização e chave do aparelho**: não existem no desktop; os shims respondem "indisponível" e o
  app já sabe seguir sem eles (esconde o recurso). A **voz** funciona, com whisper.cpp (ver `07-voz.md`).
- **Compartilhar**: não há "menu de compartilhar"; vira "Salvar como..." numa pasta escolhida.
- **Escolher documento**: abre o diálogo do sistema e **copia** o arquivo para `app-cache/DocumentPicker/` do app, porque a
  página só pode ler arquivos dentro da pasta de dados.
- **Wake lock de download**: impede o computador de suspender enquanto baixa um modelo.

## Comandos

Dentro de `desktop/`: `npm install` uma vez; `npm run dev` para desenvolver; `npm run build:web` e depois
`npm start` para rodar a versão "de produção". Gerar o instalador (.exe/.dmg) ainda não faz parte disto.
