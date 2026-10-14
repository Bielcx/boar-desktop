import i18n from "../i18n";

/**
 * Texts that say "phone", "tap", Android or GrapheneOS, reworded for the desktop app (react-native-web in
 * Electron). App.tsx merges these over the normal strings only when Platform.OS === "web"; Android never loads
 * them. Same keys as src/i18n/locales/*.json. Left out on purpose: the evaluation's share flow, which proves
 * the results come from a real phone and has no desktop version.
 */
const EN = {
  setupWizard: {
    step1: { inferenceEngineValue: "llama.cpp on this computer (Offline)" },
    step2: {
      subtitle: "It writes the answers on this computer and is downloaded once. You can change it later in Models.",
      models: {
        default: "Qwen3 4B. Fuller explanations and comparisons, a little slower. Best with 12 GB of RAM or more.",
        compact: "Qwen2.5 1.5B. Fast and light: answers start in a few seconds. Best with 8 GB of RAM or less.",
      },
      onPhone: "ON THIS COMPUTER",
      heavy: "HEAVY FOR THIS COMPUTER",
      heavyNote: "On this computer it may answer slowly and use most of the free memory.",
    },
    step3: { restartDownloads: "⟳ Downloads stuck? Click to restart" },
    step4: { subtitle: "Building the local knowledge base and search index on this computer. No internet needed." },
  },
  personalitySettings: {
    maxOutputTokensNote: "Caps how long a single response can be — lower is faster.",
  },
  voiceSettings: {
    available: "whisper.cpp on this computer (offline)",
    unavailableNote:
      "The speech engine (whisper.cpp) couldn't start on this computer. Typing still works.",
  },
  chatHeader: {
    onlineBody:
      "This computer is connected to the internet. BOAR doesn't need it: answers, search and your library all work on this computer. Only downloading models or packs and searching Hugging Face for models use the connection. Disconnect to see it work fully offline.",
    offlineBody: "No internet connection. Everything works: answers, search and your library are all on this computer.",
  },
  chatScreen: {
    reasoningUnfinished: "Reasoning didn't finish before the reply ended (stopped or out of tokens). Click 💭 to read it.",
  },
  aboutScreen: {
    airGappedBody:
      "BOAR is an offline-first AI system exploring adaptive model routing, local retrieval, and resource-aware inference. It performs local LLM inference via llama.cpp and local hybrid retrieval (SQLite FTS5 + local embeddings) with zero cloud dependencies.",
    benchmarkBody:
      "BOAR measures every answer on your own computer: model load time, time to first token, tokens/sec, peak memory and which sources were used. Run the built-in evaluation from Execution Telemetry → 🧪 Evaluate to compare any installed model on the same questions.",
  },
  personalities: { succinct: { description: "Fastest — 2–3 brief paragraphs or bullets, no preamble. The default." } },
  chat: { empty: { tagline: "Answers from this computer, with sources" } },
};

const PT = {
  setupWizard: {
    step1: { inferenceEngineValue: "llama.cpp neste computador (Offline)" },
    step2: {
      subtitle: "Ele escreve as respostas neste computador e é baixado uma vez. Você pode trocá-lo depois em Modelos.",
      models: {
        default: "Qwen3 4B. Explicações e comparações mais completas, um pouco mais lento. Melhor com 12 GB de RAM ou mais.",
        compact: "Qwen2.5 1.5B. Rápido e leve: as respostas começam em poucos segundos. Melhor com 8 GB de RAM ou menos.",
      },
      onPhone: "NESTE COMPUTADOR",
      heavy: "PESADO PARA ESTE COMPUTADOR",
      heavyNote: "Neste computador ele pode responder devagar e usar quase toda a memória livre.",
    },
    step3: { restartDownloads: "⟳ Download travado? Clique para reiniciar" },
    step4: { subtitle: "Montando a base de conhecimento local e o índice de busca neste computador. Sem internet." },
  },
  personalitySettings: {
    maxOutputTokensNote: "Limita o tamanho de uma única resposta — quanto menor, mais rápido.",
  },
  voiceSettings: {
    available: "whisper.cpp neste computador (offline)",
    unavailableNote:
      "O motor de voz (whisper.cpp) não pôde iniciar neste computador. Digitar continua funcionando.",
  },
  chatHeader: {
    onlineBody:
      "Este computador está conectado à internet. O BOAR não precisa dela: respostas, busca e sua biblioteca funcionam neste computador. Só baixar modelos ou pacotes e buscar modelos no Hugging Face usam a conexão. Desconecte para vê-lo funcionar totalmente offline.",
    offlineBody: "Sem conexão com a internet. Tudo funciona: respostas, busca e sua biblioteca estão neste computador.",
  },
  chatScreen: {
    reasoningUnfinished: "O raciocínio não terminou antes do fim da resposta (interrompido ou sem tokens). Clique em 💭 para ler.",
  },
  aboutScreen: {
    airGappedBody:
      "O BOAR é um sistema de IA offline-first que explora roteamento adaptativo de modelos, recuperação local e inferência sensível a recursos. Ele realiza inferência local de LLM via llama.cpp e busca híbrida local (SQLite FTS5 + embeddings locais) sem nenhuma dependência de nuvem.",
    benchmarkBody:
      "O BOAR mede cada resposta no seu próprio computador: tempo de carregamento do modelo, tempo até o primeiro token, tokens/s, pico de memória e quais fontes foram usadas. Rode a avaliação embutida em Telemetria de Execução → 🧪 Avaliar para comparar qualquer modelo instalado nas mesmas perguntas.",
  },
  personalities: { succinct: { description: "Mais rápido — 2–3 parágrafos curtos ou tópicos, sem introdução. O padrão." } },
  chat: { empty: { tagline: "Respostas deste computador, com fontes" } },
};

export function applyWebCopy(): void {
  i18n.addResourceBundle("en", "translation", EN, true, true);
  i18n.addResourceBundle("pt", "translation", PT, true, true);
}
