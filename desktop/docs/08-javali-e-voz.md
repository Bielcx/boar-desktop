# 08 — O javali que reage, a voz nas respostas e o javali de plantão

Duas coisas novas, pensadas pra você ir estilizando depois sem mexer em código.

## A voz lendo as respostas

- Liga em **Configurações › Voice Input › Ler respostas em voz alta** (vem desligado).
- Quando uma resposta termina, ela é lida em voz alta. As marcas de fonte `[1]`, markdown e links são pulados (`cleanForSpeech` em `src/voice/speech.ts`).
- Mandar outra pergunta, apertar Esc/parar ou abrir nova conversa interrompe a leitura.
- **Como funciona no desktop:** o `speechSynthesis` do Electron não enxerga as vozes do Windows, então o processo main usa o sintetizador do próprio Windows (System.Speech), que já vem com a **Maria (pt-BR)** e a Zira/David (en-US). Fica em `desktop/src/main/handlers/speech-output.ts`. O texto entra pela entrada padrão do processo, nunca na linha de comando.
- **No Android:** ainda não tem. O código do app procura um módulo nativo chamado `SpeechOutput` (com `speak(texto, idioma)` e `stop()`). No dia que existir um módulo Android com esse nome (TextToSpeech do sistema, ou Piper pra celular sem Google), a opção aparece sozinha.
- **Próximo passo de qualidade:** trocar o sintetizador do Windows por uma voz Piper (mais natural), mantendo a mesma API.

## O javali

### Estados (o que ele está fazendo)

`src/ui-android/mascot/mood.ts` decide, a partir do que o chat já sabe:

| Estado | Quando | Animação |
|---|---|---|
| `idle` | nada acontecendo | respira devagar |
| `listening` | microfone gravando | inclina e pulsa um anel |
| `searching` | buscando nas fontes | balança de lado, farejando |
| `thinking` | o modelo está preparando | inclina a cabeça, três pontinhos |
| `answering` | escrevendo a resposta | sobe e desce |
| `speaking` | lendo em voz alta | sobe e desce com barrinhas de som |
| `notfound` | a última resposta veio sem fonte | cabisbaixo, mais apagado |

As animações ficam em `src/ui-android/mascot/BoarBuddy.tsx` e respeitam o "reduzir movimento" do sistema.

### Crescimento (pacotes de conhecimento)

`src/ui-android/mascot/growth.ts`: cada arquivo de pacote em `documents/corpus/` conta 1.

| Estágio | A partir de | Arte |
|---|---|---|
| filhote | 0 pacotes | `assets/mascot/filhote.png` |
| jovem | 1 | `assets/mascot/jovem.png` |
| adulto | 3 | `assets/mascot/adulto.png` |
| ancião | 6 | `assets/mascot/anciao.png` |

Os limites ficam na lista `STAGES`. A tela inicial mostra o estágio e quanto falta pro próximo.

## Como estilizar (sem programar)

1. **Trocar a arte de um estágio:** substitua o PNG em `assets/mascot/` mantendo o nome. Quadrado, fundo transparente, o javali encostado na borda de baixo. 256×256 basta; até 512 fica nítido no cabeçalho e na tela inicial.
2. **Arte própria pra um estado** (ex.: um javali dormindo no `notfound`): coloque o PNG em `assets/mascot/` e adicione em `src/ui-android/mascot/art.ts`, em `moods` do estágio:
   ```ts
   adulto: { image: require("../../../assets/mascot/adulto.png"), moods: { notfound: require("../../../assets/mascot/adulto-triste.png") } },
   ```
3. **Mudar quando ele cresce:** edite os números em `STAGES` (`growth.ts`).
4. **Textos** ("Javali filhote", "faltam N pacotes…"): `src/i18n/locales/pt.json` e `en.json`, seção `mascot`.

As artes atuais são provisórias: o mascote original redimensionado e com a cor ajustada por estágio.

## O javali de plantão (pasta vigiada, só desktop)

- Liga em **Configurações › Pasta vigiada (javali de plantão)** › *Vigiar uma pasta* (vem desligado: sem pasta, nada
  roda e não aparece ícone na bandeja).
- Arquivos `.txt .md .csv .json .pdf` que aparecem ou mudam na pasta (só a primeira camada) entram sozinhos numa coleção
  com o nome da pasta; arquivo alterado substitui a versão antiga, arquivo apagado sai. Sem LLM: só leitura, pedaços e
  embeddings, o mesmo caminho do "Importar documentos".
- **Quando:** o main percebe a mudança (`fs.watch`, espera 1,5 s de calma) e revarre tudo a cada minuto (cobre evento
  perdido e nova tentativa). Lote pequeno entra na hora; lote grande (mais de 10 arquivos, mais de 5 MB ou mais de 3 PDFs)
  espera o computador **na tomada e parado há 2 min** (`powerMonitor`). Os números ficam em `HEAVY`
  (`desktop/src/main/watch.ts`).
- **Bandeja:** com alguma pasta vigiada (ou com "continuar na bandeja" ligado), o filhote (`assets/mascot/filhote.png`,
  no instalador vira `resources/mascot.png`) aparece na bandeja com Abrir / Pausar ou Retomar a vigia / Sair.
- **Aviso:** ao terminar um lote com documentos novos, notificação do sistema: "BOAR importou 3 documentos de Obra —
  pronto para perguntar". Clicar abre a janela.
- **Fechar vai pra bandeja:** interruptor nas mesmas Configurações, desligado por padrão. Ligado, fechar a janela só a
  esconde; "Sair" no menu do javali fecha de vez.
- Código: `desktop/src/main/watch.ts` (varredura, diferença, debounce, decisão de "pesado"),
  `desktop/src/main/handlers/folder-watch.ts` (diálogo, cópias, bandeja, notificação),
  `src/services/folderWatch.ts` + `syncWatchedFolder` em `src/services/documentImporter.ts` (a importação),
  `src/ui-android/FolderWatchSettings.tsx` (a tela). Segurança: `06-seguranca.md`, item 8.
