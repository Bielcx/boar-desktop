# 4. Onda 2 — ligando tudo

Na primeira onda cada peça foi testada sozinha (o banco, os arquivos, o modelo). Nesta onda o objetivo foi abrir o
app **de verdade**, numa pasta de dados vazia, passar pela configuração inicial, fazer uma pergunta e ver a resposta
chegar aos poucos, com as fontes citadas. Funcionou, e agora existe um teste automático que repete esse caminho.

## A viagem de uma pergunta

1. **Janela (renderer).** Você digita "What is a black hole?" e aperta Enter. O código do app (`src/`, o mesmo do
   Android) busca no índice local os trechos de artigo mais parecidos com a pergunta. Para isso ele precisa do
   *embedding* (um vetor de números que representa o sentido do texto).
2. **Shim → ponte.** O app chama `llama.rn` como no celular, mas no desktop esse nome aponta para o shim
   `src/shims/llama.rn.ts`, que manda a mensagem por `window.boarNative.invoke("llama.rn:embedding", ...)`. As
   buscas no banco seguem o mesmo caminho com `expo-sqlite`.
3. **Processo principal (Node).** O handler recebe a mensagem e chama o `node-llama-cpp`, que roda o modelo na
   **placa de vídeo** (Vulkan, na GTX 1650). O banco é o `node:sqlite`.
4. **Volta, um pedaço por vez.** Com os trechos em mãos, o app monta o prompt e pede a resposta
   (`llama.rn:completion`). Cada pedaço de texto gerado volta para a janela como um evento `llama.rn:token`, e a tela
   vai sendo atualizada. No fim aparecem as "Offline verified sources" com o artigo usado.

Nesta máquina: configuração inicial em ~10 s (indexar os 300 artigos embutidos), modelo carregado em ~7 s, resposta
em menos de 1 s, **~67-70 tok/s** no contador do app.

Uma dúvida da onda 1 ficou resolvida: o `node-llama-cpp` só existe como módulo ESM, e o processo principal é
CommonJS. O `import()` dinâmico funciona dentro do Electron também (o TypeScript mantém o `import()` no build), e ele
escolhe o Vulkan sozinho.

## O que quebrou e como foi resolvido

- **Caixas de confirmação não faziam nada.** No react-native-web, `Alert.alert` é uma função vazia. Então "Apagar
  modelo", "Limpar histórico", "Remover coleção" e "Limpar telemetria" nunca rodavam, e mensagens de erro nunca
  apareciam. Solução: `src/shims/rn-alert.ts` usa as caixas do próprio navegador (o Electron mostra como janela
  nativa). Um botão vira `alert`; dois ou mais viram `confirm`: OK roda o botão de ação (o destrutivo ou o padrão),
  Cancelar roda o botão "cancel". Com 3 botões ou mais, só esses dois ficam acessíveis (o app não tem nenhum hoje).
- **Botão "COPY / SHARE" dos blocos de código não fazia nada.** O react-native-web usa `navigator.share`, que não
  existe no Electron. Solução: `src/shims/rn-share.ts` copia o texto para a área de transferência.
- Os dois são trocados pelo `metro.config.js`, só quando `BOAR_TARGET=desktop`, sem tocar em `src/`.
- **Build antigo com shim novo.** O `expo export` reaproveitava o cache do Metro e não via a mudança no
  `metro.config.js`. O `build:web` agora usa `--clear` (fica um pouco mais lento, mas sempre certo).
- **Dados de teste misturados com os reais.** Nova variável `BOAR_USER_DATA=<pasta>`: o app usa essa pasta em vez de
  `%APPDATA%\BOAR`.

## Como os modelos entram sem baixar 1 GB

O app considera a configuração completa quando o modelo de embedding e um modelo de resposta estão em
`documents/models/` com o tamanho certo. O teste cria **links físicos** (hard links) dos arquivos de
`BOAR_TEST_MODELS_DIR` para essa pasta: o arquivo aparece lá, mas não ocupa espaço de novo. Os links são criados
**depois** que o assistente de configuração aparece; se existissem antes, o app pularia direto para o chat. O teste
escolhe "Qwen2.5 1.5B" e o nível "Minimum" (só os 300 artigos embutidos, nada para baixar).

## Como rodar

Dentro de `desktop/`:

```
npm run build:web          # gera web-dist/ (uma vez, e de novo quando mudar src/ ou shims)
npm start                  # abre o app (dados em %APPDATA%\BOAR)
BOAR_USER_DATA=C:\temp\boar-teste npm start      # abre numa pasta de dados separada
```

Teste ponta a ponta (PowerShell):

```
$env:BOAR_TEST_MODELS_DIR="C:\Users\bielc\Dev\boar-shared-models"; npm run e2e
```

Ele abre o app numa pasta temporária, faz a configuração, pergunta sobre buracos negros, confere que a resposta veio
em pedaços, que tem fonte citada e que não houve erro no console; depois testa o alerta (clicando em "ONLINE"), a cópia
de um bloco de código e a confirmação de "Clear All Chat History" (e que o histórico sumiu mesmo). Sem a variável, o
teste é pulado. `BOAR_E2E_SCREENSHOTS=<pasta>` guarda as capturas de tela.
