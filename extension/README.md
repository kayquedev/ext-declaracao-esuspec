# Declaração de Endereço — e-SUS

Extensão de navegador (Chrome/Edge, Manifest V3) que lê os dados **exibidos na tela**
do e-SUS (cadastro do imóvel / família e moradores) e gera a **Declaração de Endereço**
do núcleo familiar em PDF, no mesmo formato do modelo oficial usado pela Secretaria
Municipal de Saúde de São Gonçalo do Pará (texto, tabelas e brasão como marca d'água).

Não há acesso a banco de dados, API ou qualquer envio de dados pela rede: tudo roda
localmente no seu navegador, a partir do texto que já está visível na página aberta.
O brasão usado como marca d'água (`icons/logo_prefeitura.png`) fica salvo dentro da
própria extensão — nada é baixado da internet ao gerar o PDF.

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions` (ou `edge://extensions` no Edge).
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** (Load unpacked).
4. Selecione a pasta `extension` deste projeto.
5. Fixe a extensão na barra de ferramentas (ícone de quebra-cabeça → alfinete).

## Como usar

No e-SUS, o endereço/moradores e as últimas visitas ficam em **abas diferentes** do
mesmo imóvel ("Famílias e moradores" e "Últimas visitas"). A extensão navega sozinha
entre as duas com um único clique:

1. Abra o cadastro do imóvel no e-SUS (pode estar em qualquer uma das abas —
   "Informações cadastrais", "Famílias e moradores" ou "Últimas visitas").
2. Clique no ícone da extensão para abrir o formulário e clique em
   **"🔍 Extrair dados da página atual"**. A extensão:
   - garante que está na aba "Famílias e moradores" (clica nela se preciso) e lê o
     endereço do imóvel e a lista de moradores da família;
   - abre a aba "Informações cadastrais" e lê, na seção "Responsabilidade de
     acompanhamento", o nome do **Agente Comunitário de Saúde** (cartão com CBO
     "Agente comunitário de saúde") — preenche sozinho o campo **ACS responsável**;
   - clica na aba "Últimas visitas", espera carregar e lê as visitas ao imóvel;
   - volta para a aba "Famílias e moradores" ao final.
   Isso leva alguns segundos — acompanhe pela mensagem de status no popup. Quando
   termina com algum dado reconhecido, aparece no cabeçalho a tag verde
   **"DECLARAÇÃO DE ENDEREÇO FINALIZADA"**.
3. No campo **"Membro extraído"**, escolha quem é o(a) usuário(a) da declaração
   (por padrão já vem selecionado o responsável familiar). Os demais moradores são
   automaticamente listados na tabela "Também residem neste endereço".
4. O cabeçalho do PDF (Prefeitura Municipal de São Gonçalo do Pará – MG, CNPJ,
   Secretaria Municipal de Saúde e endereço da Secretaria) é **fixo** e sempre sai
   igual. O nome da UBS vem preenchido; o **CNES da unidade** é opcional — se
   preenchido, o texto sai como "UBS CENTRAL (CNES 1234567)", senão só "UBS CENTRAL".
   Nome e COREN do(a) enfermeiro(a) coordenador(a) vêm **em branco**: assim o PDF
   imprime só "Enfermeiro(a) e Coordenador(a) da Unidade" sob a linha de assinatura,
   para preencher no papel (se preenchidos no popup, saem abaixo do cargo). O **ACS responsável** agora vem preenchido pela extração (cartão
   de CBO "Agente comunitário de saúde" da aba "Informações cadastrais") — confira e
   ajuste se preciso — e use **"salvar como padrão"** se quiser alterar algum dado
   fixo permanentemente.
5. Confira/edite as "Últimas visitas realizadas à família". O accordion de
   "Últimas visitas" do e-SUS só mantém **um item aberto por vez** (abrir o próximo
   fecha o anterior), então a extensão **expande e lê uma visita de cada vez**,
   lendo o campo "Cidadão visitado" de cada painel e mantendo **só as visitas
   feitas ao(à) responsável familiar** (até 3, da mais recente para a mais antiga),
   independente do motivo/desfecho — evitando repetir no PDF visitas feitas a
   outros moradores no mesmo dia. Como no e-SUS a visita "à família" recai no
   responsável e a visita "à pessoa" (o próprio responsável) também, a mesma visita
   costuma aparecer duas vezes no mesmo dia e turno para o mesmo cidadão — essas
   duplicatas são coladas em uma só. Quando não é possível confirmar quem foi visitado
   (o e-SUS não trouxe "Cidadão visitado", ou a extensão não conseguiu descobrir o
   nome do responsável), a extensão avisa isso na mensagem de status e mostra as
   últimas visitas do imóvel sem filtrar, em vez de voltar vazia — confira
   manualmente nesse caso. Cada linha junta data e turno (ex.: "25/03/2026
   (Noite)"); a coluna "Desfecho Visita" traz apenas o campo Desfecho do e-SUS
   (ex.: "Visita realizada"). A tabela do PDF tem exatamente uma linha por visita
   encontrada (1, 2 ou 3, sem linhas em branco); sem nenhuma visita ao responsável,
   no lugar da tabela sai em negrito "NÃO EXISTEM REGISTROS DE VISITAS AO RESPONSÁVEL
   FAMILIAR NESTE ENDEREÇO".
   Se a navegação automática entre as abas falhar (layout do e-SUS mudou), abra a
   aba que faltou manualmente e clique em Extrair de novo — nada do que já foi
   extraído é apagado — ou preencha manualmente.
6. Revise todos os campos (a extração é um auxiliar, não uma fonte de verdade —
   sempre confira antes de gerar).
7. Clique em **"📄 Gerar PDF"**. O arquivo é baixado como
   `Declaracao_Endereco_<nome_do_usuario>.pdf`, com o brasão da prefeitura como
   marca d'água grande e centralizada na página, igual ao modelo oficial.

## Registrar direto no prontuário (aba "Orientações") — jeito preferido

O ideal é registrar a declaração direto na aba **Orientações** do prontuário do
cidadão no e-SUS PEC, em vez do PDF avulso — por isso o botão **"📋 Copiar para
'Orientações' (e-SUS)"** vem primeiro e em destaque no formulário. Clique nele
(mesma validação do PDF: precisa do nome do usuário e da data), abra a aba
Orientações no e-SUS e cole com **Ctrl+V**. O botão "📄 Gerar PDF" continua
disponível, para quando o PDF avulso for realmente necessário.

O texto copiado vai como HTML de verdade (a aba Orientações é um campo de texto
rico), mas testado manualmente contra o campo real: dentro de um único
parágrafo, `<br><br>` é a forma confirmada de abrir linha em branco de verdade
(`<p>` ou `<ul>` separados sozinhos não garantem quebra nenhuma). Por isso
título/parágrafo/frase de fechamento ficam num `<p>` só, com linha em branco só
antes de cada um destes 4 pontos: "DECLARAÇÃO DE ENDEREÇO", "...os seguintes
moradores:", "Últimas visitas...", "...firmo a presente declaração."; antes da
linha do ACS são quatro seguidos (`<br><br>` × 4). No resto — título → conteúdo
colado logo abaixo, linha de assinatura → nome do ACS — é só 1 `<br>`, sem linha
em branco. Moradores e visitas usam `<ul>`/`<li>` de verdade (também confirmado
colando certo) como blocos à parte entre esses parágrafos, já que `<ul>` não
pode ficar dentro de `<p>`. Tamanho de fonte, cor/destaque, `<img>`
(cola a URL da imagem como texto gigante) e `<table>` não sobrevivem ao colar e
não são usados. Não traz o cabeçalho da prefeitura
(a aba já imprime o próprio timbre), nem a data (a aba já gera a data automático
ao salvar), nem a assinatura do(a) enfermeiro(a) — a aba assina sozinha com o
profissional logado ao salvar — por isso só entra a linha `ACS <nome>` no final.

## Sobre a extração

A extração de endereço/moradores é feita por padrões de texto (regex) sobre o
conteúdo visível da página. A navegação entre abas usa o texto do rótulo
("Famílias e moradores", "Últimas visitas") em vez de seletores fixos de HTML
(classes/IDs), então tende a resistir bem a pequenas mudanças de layout do e-SUS,
mas não é garantida.

Para as visitas, a extensão tenta primeiro o caminho por "acordeão": cada visita na
aba "Últimas visitas" é um item `data-accordion-component` que revela um painel de
detalhes ao ser expandido. Como esse acordeão do e-SUS **só mantém um item aberto
por vez** (abrir o próximo fecha o anterior e o painel dele some do DOM), a extensão
**expande e lê um item de cada vez**, esperando o painel carregar antes de passar
para o próximo. De cada painel lê, pelos rótulos ("Cidadão visitado", "Data e
turno", "Desfecho", "Motivo da visita"), o cidadão visitado, a data, o turno e o
desfecho; se o painel não expôs algum desses, tenta os atributos `name` do
cabeçalho (`dataVisita`, `desfecho`, `motivoVisita`) e, por último, o texto solto
do item. A visita é mantida apenas quando "Cidadão visitado" bate com o nome do(a)
responsável familiar (independente do motivo/desfecho); as demais são descartadas.
O turno é juntado à data (ex.: "25/03/2026 (Noite)") e a coluna "Desfecho Visita"
recebe só o campo Desfecho ("Visita realizada" etc.).

A extensão só confia nesse filtro (inclusive quando o resultado é zero visitas) se
pelo menos um painel realmente trouxe "Cidadão visitado" **e** ela descobriu o nome
do responsável. Caso contrário cai para uma leitura posicional da tabela inteira
(Data da visita, Desfecho, Motivo da visita, nessa ordem, usando a data como âncora
de cada linha) — sem filtrar por morador — e diz isso na mensagem de status, para
nunca voltar vazia sem avisar. Se o e-SUS mudar os nomes desses atributos/rótulos
ou a ordem das colunas, a extração pode parar de funcionar e precisa de ajuste.

Por isso o formulário sempre abre editável: revise nome, CPF/CNS, endereço e as
listas de moradores/visitas antes de gerar o PDF.

## Estrutura de arquivos

- `manifest.json` — configuração da extensão (Manifest V3).
- `popup.html` / `popup.css` / `popup.js` — interface e lógica (extração,
  tabelas dinâmicas de moradores/visitas, marca d'água e geração do PDF).
- `icons/logo_prefeitura.png` — brasão oficial do município, usado como marca
  d'água na declaração.
- `lib/jspdf.umd.min.js` — biblioteca [jsPDF](https://github.com/parallax/jsPDF)
  (vendorizada localmente; extensões não podem carregar scripts de CDN).

## Permissões usadas

- `activeTab` + `scripting`: para ler o texto da aba ativa **somente quando você
  clica no botão de extração** (não roda em segundo plano, não monitora navegação).
- `storage`: para lembrar os dados fixos da unidade (prefeitura, UBS, ACS etc.)
  entre uma declaração e outra, salvos localmente no seu navegador.
