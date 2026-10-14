# 6. Segurança do app desktop

## A ideia em uma frase

A página do app (a interface) roda num navegador embutido e **não deve ser confiável**: se um dia alguém
conseguir rodar código nela (um bug, um texto malicioso que vira HTML, uma dependência comprometida), esse
código só pode fazer o que o app faz, e nada além. Todo o resto é o processo **main** (Node) dizendo "não".

A página fala com o main por `window.boarNative.invoke("pacote:método", ...)`. Cada correção abaixo fecha uma
porta por onde essa conversa podia ir longe demais.

## O que foi encontrado e como cada correção funciona

**1. SQL que escrevia arquivo em qualquer lugar.** O app manda SQL cru para o main (é assim que o expo-sqlite
funciona). O SQLite tem dois comandos que abrem *outro* arquivo: `ATTACH DATABASE 'caminho'` e
`VACUUM INTO 'caminho'`. Com eles dava para criar um arquivo, por exemplo, na pasta "Inicializar" do Windows,
que roda sozinho no próximo login. **Correção:** cada banco aberto ganha um *authorizer*, uma função que o
SQLite consulta antes de executar cada operação. Toda vez que o SQLite quer anexar um arquivo, ele pergunta com
o nome do arquivo; respondemos "negado" para qualquer nome que não seja vazio. O `VACUUM` normal (que o app usa
depois de limpar a base) anexa um banco temporário de nome vazio, então continua funcionando. Também ligamos o
modo *defensive* e `trusted_schema=OFF` (um arquivo de banco adulterado não consegue disparar funções ao ser
lido), e extensões continuam desligadas.

**2. Navegação e IPC por origem "null".** A janela só deveria navegar dentro do app. A checagem comparava
`URL.origin`, mas para `app://`, `file:` e `data:` a origem é a palavra `"null"`, então qualquer uma dessas
passava. **Correção:** compara pelo começo do endereço (`app://boar/` no app instalado, o servidor do Expo em
dev); o resto é bloqueado, e só links `http(s)` abrem no navegador do sistema. Além disso, todo `ipcMain.handle`
passa por um porteiro (`guardedHandle` em `handlers/context.ts`): só atende quem é o quadro principal da janela
e está numa página do app. Um iframe, ou a janela depois de ir parar em outro lugar, recebe erro.

**3. Sem Content-Security-Policy.** A CSP é uma regra que o navegador aplica à página: "só rode scripts que
vieram daqui". **Correção:** o protocolo `app://` devolve o cabeçalho com `script-src 'self'`, sem `eval`, sem
objetos, sem iframes, e conexões só para o próprio app e para `https://huggingface.co` (a busca de modelos em
Configurações; os arquivos dos modelos baixam pelo main, não pela página). Estilos inline são permitidos porque o react-native-web gera CSS
em tempo de execução. Em dev (`npm run dev`) não há CSP: o bundle do Metro precisa de `eval`.

**4. Caminho de rede vazando a senha do Windows (hash NTLM).** Um URI `file://servidor/pasta/x` vira
`\\servidor\pasta\x` no Windows. Só de *olhar* se esse arquivo existe, o Windows conecta no servidor e manda o
hash da senha do usuário. O guarda de caminhos (`safePath.ts`) e o do modelo (`engine.ts`) olhavam o disco antes
de checar se o caminho era permitido. **Correção:** a checagem agora é primeiro só no texto (está dentro da
pasta do app?), e caminhos que começam com `\\` são recusados antes de qualquer acesso ao disco. O motor do
modelo só aceita `file://`.

**5. A pasta permitida era grande demais.** A página podia ler qualquer coisa em `%APPDATA%\BOAR`, que também
guarda o perfil do Chromium (cookies, armazenamento local). **Correção:** só `documents/` e `app-cache/`
(e, para modelos, a pasta extra `BOAR_MODELS_DIR` se existir). O cache do app virou `app-cache` porque `cache`
e o `Cache` do Chromium são a mesma pasta num disco que não diferencia maiúsculas.

**6. Download que podia cair para http.** Só o primeiro endereço era checado como `https`; um redirecionamento
podia levar para `http` (sem criptografia, adulterável no caminho). **Correção:** os redirecionamentos são
seguidos à mão, cada salto checado (máximo 10). A mensagem de erro não repete mais o texto que o servidor
mandou, e cabeçalhos vindos da página não são repassados (o app não manda nenhum).

**7. Permissões do navegador.** Sem regra, a página podia pedir câmera, microfone, localização, notificações...
**Correção:** tudo negado, exceto escrever na área de transferência (o botão de copiar do chat) e, para a entrada
por voz (`docs/07-voz.md`), o **microfone**: só áudio (pedido com vídeo é negado), só do quadro principal da página do
próprio app (`app://boar/`, ou o servidor de dev).

**8. Pasta vigiada (javali de plantão).** O app passou a ler arquivos de pastas do usuário fora do `userData`, mas
sem abrir o `safePath`: a página continua só enxergando `documents/` e `app-cache/`. Como ficou:
- O caminho da pasta só entra por um **diálogo nativo aberto pelo main** (`folder-watch:addFolder`); a página não manda
  caminho nenhum, só pede "abrir o diálogo", "parar de vigiar a pasta <id>", "pausar", "fechar vai pra bandeja". Caminho
  de rede (`\servidor\...`) é recusado, pelo mesmo motivo do item 4. A lista fica em `<userData>/folder-watch.json`,
  fora das pastas que a página alcança.
- O main lista só a primeira camada da pasta, só `.txt .md .csv .json .pdf` até 100 MB, e **copia** cada arquivo novo ou
  alterado para `app-cache/FolderWatch/<uuid>-<nome>` (como o seletor de arquivos faz). A página importa a cópia e a
  apaga; o main limpa essa pasta ao abrir, caso uma importação tenha ficado pela metade.
- A página recebe o caminho das pastas para mostrar nas Configurações (só texto) e manda de volta, além do resultado,
  os textos do menu da bandeja e da notificação no idioma dela (cortados em 200 caracteres). O pior que uma página
  comprometida faz com isso é um texto estranho na bandeja ou numa notificação do BOAR.
- A notificação é do processo main (`Notification` do Electron); a permissão de notificações da página continua negada
  (item 7).

**9. Servidor MCP (biblioteca para outros apps).** Desligado por padrão; só leitura (banco `readOnly` e só canais
de leitura registrados), só stdio, só as coleções marcadas, nenhum caminho vindo do cliente. Detalhes em
`docs/09-mcp.md`.

**10. PIN e conversas trancadas (o mesmo esquema do app nativo).** Sem PIN, as conversas ficavam em texto puro no
`aoair_knowledge.db`: qualquer programa na conta, um backup ou o disco copiado lia tudo. Com PIN (Configurações ›
Segurança, desligado por padrão):
- Título, resumo, texto e meta (fontes, recibo) de cada conversa vão ao banco como `enc1:<base64>`, AES-256-GCM
  com nonce próprio, no formato do `TextCipher.kt` do app nativo (`src/security/textCipher.ts`). Ids, horários e
  notas ficam abertos.
- Uma chave de dados aleatória tranca as conversas. Ela é guardada em `<userData>/pin.json`, selada duas vezes: com
  uma chave derivada do PIN (PBKDF2-HMAC-SHA256, 210 mil iterações) e depois com o DPAPI da conta do Windows
  (`safeStorage`). Sem a mesma conta, nem o PIN certo abre. O PIN nunca é guardado.
- As tentativas erradas são contadas no main, fora do alcance da página: da 5ª em diante, espera de 30 s, que
  dobra a cada erro, até 1 h.
- Ligar ou desligar re-sela todas as conversas numa transação e roda `VACUUM`, para o texto antigo não ficar em
  páginas livres nem no WAL.
- Trancado, nada é gravado: uma escrita falha em vez de cair aberta no disco. O app tranca na abertura e depois
  de 5 minutos com a janela fora de foco.
- "Esqueceu o PIN?" apaga as conversas. Documentos, pacotes e modelos ficam.
- **Fora do escopo:** documentos importados continuam abertos, porque a busca por palavras (FTS5) precisa do
  texto. Trancar documentos é a próxima fase. Enquanto o app está aberto e destrancado, o texto está na memória.

**11. Servidor de API local (HTTP com tokens).** Uma porta HTTP aberta é superfície nova, então ela fica fechada
por padrão e, ligada, só escuta em `127.0.0.1`. Recusa `Host` que não seja o próprio (ataque de DNS rebinding) e
qualquer pedido com `Origin` (página da web), mesmo com token. O token tem 256 bits aleatórios e é guardado só como
hash SHA-256, comparado em tempo constante. Tem validade e revogação, limite de 60 pedidos por minuto e corpo até
1 MB. Com o BOAR trancado por PIN, a API recusa (423). Detalhes em `docs/10-api.md`.

## Outras correções da mesma rodada (não são de segurança, mas evitam travas)

- O download agora usa `pipeline`: disco cheio ou destino inválido viram um erro normal, em vez de derrubar o
  main ou travar para sempre esperando o disco.
- Retomar um download já completo (o servidor responde 416) conta como concluído.
- A leitura de RAM vem pronta na abertura da janela, então a primeira conta "o modelo cabe na memória?" não vê 0.
- Recarregar a página libera os modelos carregados (gigabytes de RAM), como já acontecia com os bancos.

## Onde estão os testes

`test/shims.test.ts`: ATTACH/VACUUM INTO recusados e VACUUM normal funcionando; porteiro do IPC; caminhos de
rede recusados sem tocar no disco; resto do userData recusado; redirecionamentos; erro sem texto do servidor;
erro de escrita sem travar; 416. `test/llama.rn.test.ts`: o guarda de caminho do modelo. As specs de `e2e/`
rodam o app com a CSP ligada e falham se aparecer qualquer erro no console (uma violação de CSP é um erro).
`test/folder-watch.test.ts` e `e2e/folder-watch.spec.ts`: a pasta vigiada (o diálogo é simulado no main).
`test/pin-lock.test.ts`, `test/chat-seal.test.ts` e `e2e/pin.spec.ts`: o PIN (cofre, espera, conta diferente não
abre, nenhum texto das conversas nos arquivos do banco, nada gravado trancado, "esqueci" apaga).
`test/api-server.test.ts` e `e2e/api.spec.ts`: o servidor de API (sem token, token errado, vencido e revogado dão
401; Host e Origin dão 403; limite 429; streaming; trancado 423).
