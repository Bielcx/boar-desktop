# Política de Privacidade do BOAR

> **Prévia: primeiro rascunho, em revisão.** Esta política descreve o que o BOAR faz hoje, com a
> maior precisão possível, mas ainda não passou por revisão jurídica e pode mudar. Publicamos agora
> para que você saiba o que o app faz com os dados antes da versão final. Dúvidas ou correções:
> privacy@boarapp.com ou uma issue em [github.com/rferrari/boar-app](https://github.com/rferrari/boar-app/issues).

Versão 0.9 (prévia) · 30 de setembro de 2026 · Contato: privacy@boarapp.com

> Esta é uma tradução da [versão em inglês](../../PRIVACY.md). Se as duas forem diferentes, prevalece
> a versão em inglês, exceto quando a lei local exigir o contrário. Para titulares no Brasil, os
> direitos previstos na LGPD e no Código de Defesa do Consumidor se aplicam em qualquer caso.

O BOAR é um aplicativo de pesquisa com IA offline para Android e iOS, e boarapp.com é o seu site. O
BOAR é um projeto gratuito e de código aberto, feito pela sua comunidade de colaboradores ("nós"). Não
há uma empresa por trás dele. Os mantenedores do projeto operam o serviço de compartilhamento e tratam
os dados pessoais descritos aqui (o "controlador", nos termos do GDPR e da Lei Geral de Proteção de
Dados Pessoais, LGPD, Lei nº 13.709/2018); o contato com eles é privacy@boarapp.com.

Esta política cobre o aplicativo BOAR (a versão padrão e a versão offline) e o site boarapp.com. Ela
foi escrita tendo em vista o GDPR da União Europeia e do Reino Unido, a LGPD, a CCPA/CPRA da
Califórnia e leis semelhantes, e vale para todas as pessoas, onde quer que estejam.

## Em resumo

- **Suas perguntas, respostas, conversas e documentos nunca saem do seu celular.** O BOAR responde
  com um modelo que roda no próprio celular. Não há conta, publicidade, nem analytics ou relatório de
  falhas no app.
- **O app só usa a internet quando você pede:** para baixar modelos e pacotes, buscar um modelo no
  Hugging Face e compartilhar uma rodada de avaliação. A versão offline não tem permissão de internet.
- **Compartilhar uma rodada é opcional.** Você vê tudo o que será enviado antes de confirmar. O que se
  torna público é o modelo e o chip do celular com suas pontuações, nunca algo que identifique você.
- **Proteger o seu celular cabe a você.** O BOAR guarda seus dados no celular e não os criptografa
  além do que o sistema faz para qualquer app (seção 9).

## 1. O que fica no seu celular

Estes dados são tratados apenas no seu aparelho e o BOAR nunca os envia para nós nem para ninguém:

- suas perguntas e as respostas do BOAR, as conversas e seus resumos;
- os documentos que você importa e as coleções criadas a partir deles;
- a base de conhecimento e as buscas feitas nela;
- sua localização: lida só quando você pergunta sobre lugares por perto, usada no aparelho e nunca
  enviada pelo BOAR, que não usa geocodificador. No Android, vem só do GPS do celular, sem serviço de
  localização pela rede. No iPhone, vem do Core Location do iOS, que também pode usar Wi-Fi e rede
  celular pelo serviço de localização da Apple, sob a política de privacidade da Apple;
- o registro de desempenho do BOAR (modelo, velocidade e memória de cada resposta), que nunca inclui
  suas perguntas ou respostas e só sai do celular se você mesmo exportá-lo;
- as rodadas de avaliação (as perguntas de teste fixas do BOAR e as respostas do modelo a elas), até
  você compartilhar ou exportar uma;
- suas configurações e uma chave de segurança que o BOAR cria no hardware seguro do celular para o
  compartilhamento.

**Como apagar:** Ajustes → "Apagar todos os dados" apaga suas conversas, documentos, modelos, pacotes
de conhecimento e configurações. Duas coisas ficam até você desinstalar o app: as rodadas de
avaliação salvas e a chave de compartilhamento. Desinstalar o BOAR apaga tudo o que ele guardou no
celular.

## 2. Quando o app usa a internet

A versão padrão só se conecta à internet nos casos abaixo, sempre iniciados por você. Nada é enviado
em segundo plano.

### 2.1 Baixar modelos, pacotes de conhecimento e lugares

Quando você configura o BOAR ou toca em "Baixar", o celular busca o arquivo no **Hugging Face**
(huggingface.co) ou no **GitHub** (github.com, raw.githubusercontent.com). O BOAR envia só o pedido do
arquivo. Como qualquer site, esses serviços veem seu endereço IP, o horário e o arquivo pedido, sob as
próprias políticas de privacidade ([Hugging Face](https://huggingface.co/privacy),
[GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)). Nós
não recebemos nada disso.

### 2.2 Buscar um modelo no Hugging Face

Se você usar "Buscar no Hugging Face", o BOAR envia as palavras da sua busca para a API pública do
Hugging Face, só no momento da busca. Vale a política de privacidade do Hugging Face.

### 2.3 Compartilhar uma rodada de avaliação (opcional)

A tela de Avaliação pode rodar o conjunto fixo de perguntas de teste do BOAR e, se você escolher
**"Compartilhar resultados"**, enviar a rodada para nós, para que qualquer pessoa compare o desempenho
dos modelos em celulares diferentes. O compartilhamento está disponível no Android; no iOS ainda não
foi liberado. Antes de qualquer envio, o app mostra todos os campos. Recebemos:

- **sobre o celular:** plataforma, versão e nível de API do sistema, marca e modelo, chipset e seu
  fabricante, nome da placa, RAM total, número de núcleos da CPU, recursos da CPU e velocidades dos
  núcleos;
- **sobre a rodada:** seu identificador, as versões do app e do conjunto de testes e, para cada
  pergunta de teste, o modelo usado, a resposta que o modelo escreveu para a *nossa* pergunta fixa, as
  fontes encontradas, os tempos, a memória e se ela terminou;
- **uma chave de segurança criada para o BOAR no hardware seguro do celular.** A parte pública dela e,
  no primeiro envio, o certificado do fabricante provam que a rodada vem de um celular real rodando o
  app oficial. O certificado também mostra o nível de atualização de segurança do celular e se o
  bootloader está bloqueado. A chave não está ligada a você, às suas contas nem ao seu número;
- **um hash com chave do seu endereço IP** (SHA-256 com um segredo que só o servidor conhece), usado
  apenas para limitar quantas rodadas uma mesma rede pode enviar. Não guardamos o endereço IP em si.

Nunca recebemos suas próprias perguntas, conversas, documentos, nome, contatos ou localização.

**O que é público:** a marca e o modelo do celular, o chipset, a RAM, as informações dos núcleos, as
versões do app e dos testes, e as pontuações e velocidades de cada modelo. Isso aparece nos resultados
públicos, que qualquer pessoa pode ler. A chave, o hash do IP, as respostas e os detalhes do
certificado nunca são públicos.

**Revisão:** alguns celulares legítimos não conseguem provar que a chave vem de hardware seguro. As
rodadas deles são guardadas, mas ficam ocultas até a equipe do BOAR revisá-las.

### 2.4 Entrada por voz

A entrada por voz fica desligada até você ligá-la. No iPhone e no Android 12 ou mais recente, a fala é
reconhecida no próprio celular. Em alguns Android mais antigos, a voz usa o serviço de fala do próprio
celular, que pode enviar o áudio ao fornecedor dele (em geral o Google). O BOAR avisa e pede
autorização antes. Vale a política de privacidade desse fornecedor, e nós nunca recebemos o áudio nem
o texto.

### 2.5 Abrir um lugar no app de mapas

Se você tocar em "Abrir no mapa" em um lugar, o BOAR passa as coordenadas desse lugar para o app de
mapas que você escolher. A partir daí vale a política de privacidade desse app.

### 2.6 A versão offline

A versão offline do BOAR não tem permissão de internet. Nada da seção 2 se aplica a ela: modelos e
pacotes são importados de arquivos, e nada pode ser compartilhado.

## 3. O site (boarapp.com)

- **Hospedagem:** o boarapp.com é hospedado pela Vercel, que registra os acessos (endereço IP,
  horário, página) para manter e proteger o site
  ([política de privacidade da Vercel](https://vercel.com/legal/privacy-policy)).
- **Analytics:** o site usa o Google Analytics 4 para contar visitas e ver quais páginas são lidas.
  Ele coleta sua localização aproximada, aparelho, navegador e as páginas que você visita, e grava
  cookies; o Google Analytics 4 não guarda endereços IP. Estamos adicionando um aviso de consentimento
  para que ele só carregue se você aceitar. Até lá, você pode bloqueá-lo com o
  [complemento de desativação do Google](https://tools.google.com/dlpage/gaoptout) ou qualquer
  bloqueador de conteúdo. Veja [como o Google usa os dados](https://policies.google.com/technologies/partner-sites).

## 4. Por que tratamos os dados (bases legais)

| O quê | Por quê | Base legal (GDPR / LGPD) |
|---|---|---|
| Uma rodada compartilhada e os dados do celular | Publicar resultados comparáveis, porque você pediu | Consentimento (art. 6(1)(a) GDPR; art. 7º, I, LGPD) |
| A chave de segurança, o certificado e o hash do IP | Impedir rodadas falsas, automatizadas ou repetidas | Legítimo interesse em manter os resultados honestos (art. 6(1)(f) GDPR; art. 7º, IX, LGPD) |
| Analytics do site | Ver como o site é usado | Legítimo interesse hoje; consentimento quando o aviso estiver no ar |
| Registros de acesso do site | Manter e proteger o site | Legítimo interesse |

Você pode retirar o consentimento a qualquer momento. Isso não afeta o que já foi feito e, para uma
rodada compartilhada, retirar o consentimento significa pedir que a apaguemos (seção 7).

Não vendemos seus dados pessoais, não os compartilhamos para publicidade direcionada e não os usamos
para tomar decisões automatizadas sobre você.

## 5. Quem trata os dados

- A **Supabase** guarda as rodadas compartilhadas, na Amazon Web Services nos Estados Unidos
  (us-west-2), sob os termos de tratamento de dados da Supabase.
- A **Vercel** hospeda o site. O **Google** fornece o analytics do site.
- O **Hugging Face** e o **GitHub** servem os downloads (seção 2.1), como serviços independentes.

Alguns deles ficam nos Estados Unidos. Quando a lei exige, as transferências são cobertas pelas
cláusulas contratuais padrão dos fornecedores ou por garantias equivalentes (art. 46 do GDPR; art. 33
da LGPD).

## 6. Por quanto tempo guardamos

| Dado | Guardado por |
|---|---|
| Códigos de uso único do compartilhamento | Apagados após 1 hora |
| Rodadas compartilhadas, suas respostas, os dados do celular, a chave e o hash do IP | Enquanto os resultados públicos existirem, ou até você pedir que sejam apagados |
| Analytics do site | O prazo de retenção configurado no Google Analytics (2 meses) |

As rodadas não podem ser alteradas depois de guardadas. Só nós podemos apagá-las, e fazemos isso a
pedido. Pretendemos apagar os hashes de IP após 7 dias, já que os limites só olham as últimas 24
horas; até lá, eles ficam guardados com a rodada.

## 7. Seus direitos

Onde quer que você esteja, pode nos pedir para:

- informar o que temos sobre você e lhe dar uma cópia (acesso, portabilidade);
- corrigir ou apagar esses dados (eliminação);
- parar ou restringir o uso deles, ou se opor à forma como os usamos;
- retirar o seu consentimento.

**Como pedir:** envie um e-mail para privacy@boarapp.com. O BOAR não tem contas, então só conseguimos
encontrar uma rodada compartilhada pelos detalhes dela. Informe o identificador da rodada (a tela de
Avaliação mostra depois de cada rodada, na linha "Salvo em": `eval-<data e hora>`), o modelo do seu
celular e mais ou menos quando você compartilhou. Respondemos em até 30 dias (15 dias no Brasil; 45
dias pela CCPA) e nunca cobramos por isso.

**Conforme onde você mora:**

- **União Europeia, EEE e Reino Unido:** você também pode reclamar à sua autoridade de proteção de
  dados.
- **Brasil (LGPD, art. 18):** como titular, você tem os direitos acima, além de confirmação de que
  tratamos seus dados, anonimização de dados desnecessários, informação sobre com quem os
  compartilhamos e revisão do consentimento. Você pode reclamar à ANPD (Autoridade Nacional de
  Proteção de Dados).
- **Califórnia (CCPA/CPRA) e outros estados dos EUA com leis de privacidade:** você tem direito de
  saber, apagar, corrigir e recusar a venda ou o compartilhamento. Não vendemos nem compartilhamos
  informações pessoais, e não trataremos você de forma diferente por exercer seus direitos.

## 8. Crianças

O BOAR não é voltado a crianças menores de 13 anos, ou de 16 onde a lei local fixa essa idade para o
consentimento (por exemplo, em partes da União Europeia). Não coletamos dados pessoais delas de
propósito. Se você acha que uma criança compartilhou uma rodada, fale conosco e vamos apagá-la.

## 9. Segurança, e o que cabe a você

**No servidor:** as rodadas compartilhadas são assinadas com a chave de hardware do celular e enviadas
por HTTPS. O servidor confere cada assinatura e código de uso único, e as rodadas guardadas não podem
ser alteradas nem apagadas, exceto por nós. O banco de dados é privado, com exceção das pontuações
públicas, e não guarda nada que identifique você pelo nome. Se um incidente puser seus dados em risco,
avisaremos as autoridades e as pessoas afetadas como a lei exige.

**No seu celular:** tudo o que está na seção 1 fica no seu celular, sob o seu controle. O BOAR não
criptografa esses dados além do que o sistema operacional faz para qualquer app. No Android, os dados
do BOAR ficam fora do backup na nuvem e da transferência entre aparelhos; no iOS, a pasta de
documentos do app aparece no app Arquivos e pode entrar no backup do iCloud. Quem conseguir
desbloquear ou tomar o controle do seu celular, ou ler os backups dele, consegue ler o que o BOAR
guardou. Manter seguros o seu celular, o bloqueio de tela, os backups e tudo o que você exportar cabe
a você.

**Código aberto:** o código do BOAR é público. Isso permite que qualquer pessoa confira o que ele faz,
e também que qualquer pessoa procure falhas nele. Como todo software, ele pode ter falhas de segurança
que não conhecemos, e os serviços dos quais depende podem ser atacados ou falhar. Nenhum sistema é
perfeitamente seguro, e não podemos garantir que o nosso nunca será invadido. Instale o BOAR só pela
página oficial de versões ou por uma fonte de confiança: uma cópia modificada não é nossa e não está
coberta por esta política.

## 10. Mudanças

Quando esta política mudar, atualizamos a versão e a data acima e descrevemos a mudança no histórico
do repositório. Para mudanças importantes, o app ou o site avisará antes de elas valerem.

## 11. Contato

Pedidos e dúvidas sobre privacidade: **privacy@boarapp.com**.
O código-fonte, incluindo todos os pontos em que o app usa a rede, é público em
[github.com/rferrari/boar-app](https://github.com/rferrari/boar-app).
