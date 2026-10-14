# 5. Onda 3 — o instalador

Até aqui o app só rodava a partir do código (`npm start`). Nesta onda ele virou um **programa instalável**: um
`BOAR-Setup-0.1.0.exe` que qualquer pessoa com Windows 10/11 64 bits baixa, clica duas vezes e usa, sem Node, sem
`npm install`, sem nada.

```
npm run dist      # dentro de desktop/: compila o main, gera o web-dist e empacota
```

Saída em `desktop/release/`:

- `BOAR-Setup-0.1.0.exe` (~103 MB): instalador. Instala só para o usuário atual (em
  `%LOCALAPPDATA%\Programs\boar-desktop`, nome que vem do `name` do `package.json`), sem pedir senha de
  administrador, e cria atalho no Menu Iniciar. Instalado ocupa
  ~450 MB. Desinstala pelo "Adicionar ou remover programas". Os dados (modelos, banco, conversas) ficam em
  `%APPDATA%\BOAR` e **não** são apagados na desinstalação.
- `win-unpacked/`: o mesmo app já "instalado", só que numa pasta. Dá para rodar `BOAR.exe` direto, útil para testar.

## O que o electron-builder faz

É uma ferramenta que pega o projeto e monta o programa final:

1. Copia o Electron (o Chromium + Node que roda o app) e renomeia `electron.exe` para `BOAR.exe`, com o ícone do app
   (`assets/icon.png`). Ele usa o Electron que já está em `node_modules/electron/dist` (opção `electronDist`), então
   não baixa nada de novo.
2. Junta o nosso código (`dist/`, `web-dist/`) e as dependências de produção (`dependencies` do `package.json`, não
   as `devDependencies`) num único arquivo, o `app.asar`.
3. Gera o instalador com o **NSIS** (um criador de instaladores para Windows).

A configuração fica no campo `"build"` do `desktop/package.json`. O `appId` (`io.github.bielcx.boar`) é definitivo desde a v0.1.0: é a
"identidade" do app para o Windows (atalhos, notificações). Não mude mais
depois, senão o Windows trata a versão nova como outro programa.

## asar e asarUnpack

O `app.asar` é como um `.zip` sem compressão: milhares de arquivos pequenos viram um só, o que deixa a instalação
mais rápida e o antivírus mais calmo. O Node do Electron sabe ler arquivos lá de dentro como se fosse uma pasta.

A exceção são os **binários nativos** (`.node` e `.dll`): quem carrega esses arquivos é o próprio Windows, e o
Windows não sabe abrir um `.asar`. Por isso o `asarUnpack` manda os arquivos de `node_modules/@node-llama-cpp/**`
para a pasta `app.asar.unpacked/`, ao lado. O Electron redireciona o carregamento para lá sozinho; o código
(`import("node-llama-cpp")`) não muda nada.

## Por que só alguns binários do node-llama-cpp

O `node-llama-cpp` traz o motor de IA já compilado para **todas** as combinações de sistema e placa de vídeo:
Windows/Linux/Mac, CPU, Vulkan, CUDA, Metal… São ~685 MB, e um usuário de Windows usa um ou dois. O pacote leva só:

- `@node-llama-cpp/win-x64-vulkan` (~99 MB): roda na placa de vídeo via **Vulkan**, que funciona em NVIDIA, AMD e
  Intel. É o que o app escolhe nesta máquina (GTX 1650).
- `@node-llama-cpp/win-x64` (~47 MB): só CPU, a rede de segurança se a placa não aceitar o Vulkan.

O **CUDA** (~520 MB, só NVIDIA) ficou de fora: o Vulkan já usa a NVIDIA e o ganho não paga o tamanho. Para isso o
`desktop/.npmrc` tem `omit=optional` (o npm não instala os ~685 MB opcionais em `desktop/node_modules`) e os dois
pacotes acima entram como dependências normais. Custo em disco no desenvolvimento: ~146 MB a mais em
`desktop/node_modules`, não 685 MB.

Testado no `.exe` empacotado: configuração inicial, modelo carregado e resposta com fonte citada; o processo carregou
`ggml-vulkan.dll` de `app.asar.unpacked\...\win-x64-vulkan` e listou a GTX 1650 como dispositivo Vulkan.

## pdf.js (importar PDF)

O `pdfjs-dist` tem ~35 MB, quase tudo para *desenhar* PDFs (visualizador, fontes, decodificadores de imagem). Para
só ler o texto bastam o build `legacy/build` e os `cmaps` (tabelas de caracteres de fontes chinesas/japonesas/coreanas);
o resto é cortado com `!node_modules/pdfjs-dist/...` em `files`. Custo: +4,7 MB no `app.asar` e +1 MB no instalador.
Para conferir no app empacotado: `BOAR_E2E_EXE=release/win-unpacked/BOAR.exe npx playwright test documents.spec.ts`.

## Assinatura, SmartScreen e Gatekeeper

O instalador **não é assinado** (assinar exige um certificado de "code signing", pago, ~US$ 200-400/ano, emitido
para uma empresa ou pessoa verificada). Consequência: ao abrir o `.exe` baixado da internet, o Windows mostra a tela
azul do **SmartScreen** ("O Windows protegeu o computador"). A pessoa precisa clicar em "Mais informações" →
"Executar assim mesmo". Alguns antivírus também desconfiam mais de programas sem assinatura. Com certificado, basta
configurar `win.signtoolOptions` (ou as variáveis `CSC_LINK`/`CSC_KEY_PASSWORD`); o aviso some aos poucos, conforme
o certificado ganha reputação (com certificado EV some na hora).

No Mac o equivalente é o **Gatekeeper**: sem assinatura **e notarização** da Apple (conta de desenvolvedor, US$ 99/ano),
o macOS recente simplesmente não abre o app baixado ("está danificado" ou "não pode ser verificado").

## E macOS / Linux?

O código já é multiplataforma; falta empacotar, e isso precisa ser feito **em cada sistema** (ou num CI com máquinas
de cada um), porque os binários nativos e o próprio Electron são diferentes:

- **macOS:** rodar `npm run dist` num Mac. Trocar as dependências `@node-llama-cpp/win-*` por `mac-arm64-metal`
  (Apple Silicon, usa a GPU via Metal) e/ou `mac-x64`; adicionar `"mac": { "target": "dmg" }`, um ícone `.icns` e,
  para distribuir de verdade, assinatura + notarização.
- **Linux:** rodar num Linux, com `@node-llama-cpp/linux-x64` + `linux-x64-vulkan` e `"linux": { "target":
  "AppImage" }` (ou `deb`). Não há aviso de assinatura no Linux.

Como as dependências mudam por sistema, o jeito mais simples quando chegar a hora é um job de CI por sistema
(GitHub Actions tem Windows, macOS e Linux) instalando o pacote certo antes do `npm run dist`.

## Limites conhecidos

- Sem atualização automática (o `electron-updater` resolve isso, mas precisa de um lugar para publicar as versões).
- O `npm audit` aponta o Electron 40.10.2 como vulnerável (corrigido em versões mais novas); atualizar o Electron
  antes de publicar.
- O instalador é de um clique (`oneClick`): não pergunta a pasta. Para um assistente com opções, `"oneClick": false` em `"nsis"`.
