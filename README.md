# Extensão Geração Declaração Endereço PDF do e-SUS PEC

Extensão de navegador (Chrome/Edge, Manifest V3) que lê os dados **exibidos na
tela** do e-SUS PEC (cadastro do imóvel — informações cadastrais, famílias e
moradores, últimas visitas) e gera a **Declaração de Endereço** do núcleo
familiar em PDF, no formato do modelo oficial usado pela Secretaria Municipal de
Saúde (texto, tabelas e brasão como marca d'água).

Não há acesso a banco de dados, API ou qualquer envio de dados pela rede: tudo
roda localmente no navegador, a partir do texto já visível na página aberta.

## O que a extensão faz

- Navega sozinha entre as abas **"Informações cadastrais"**, **"Famílias e
  moradores"** e **"Últimas visitas"** do imóvel e extrai:
  - endereço do imóvel e microárea;
  - lista de moradores da família (nome, CPF/CNS, parentesco);
  - o **Agente Comunitário de Saúde** responsável (seção "Responsabilidade de
    acompanhamento", cartão com CBO "Agente comunitário de saúde");
  - as **últimas visitas ao(à) responsável familiar** (até 3, mais recentes
    primeiro). O accordion do e-SUS só mantém um item aberto por vez, então a
    extensão expande e lê **uma visita de cada vez**; visitas repetidas no mesmo
    dia/turno para o mesmo cidadão contam como uma só.
- Preenche um formulário editável e gera o PDF (`Declaracao_Endereco_<nome>.pdf`).

A extração é um **auxiliar heurístico** — o formulário sempre abre editável e os
campos devem ser conferidos antes de gerar o PDF.

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. **Carregar sem compactação** → selecione a pasta [`extension/`](extension/).
4. Fixe a extensão na barra de ferramentas.

Documentação de uso detalhada em [`extension/README.md`](extension/README.md).

## Estrutura

| Caminho | Descrição |
|---|---|
| `extension/manifest.json` | Configuração da extensão (Manifest V3). |
| `extension/popup.html` · `popup.css` · `popup.js` | Interface e lógica (extração, tabelas dinâmicas, marca d'água, geração de PDF). |
| `extension/icons/logo_prefeitura.png` | Brasão do município (marca d'água). |
| `extension/lib/jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) vendorizado (MIT) — extensões não carregam script de CDN. |

## Permissões

- `activeTab` + `scripting`: ler o texto da aba ativa **somente ao clicar em
  Extrair** — não roda em segundo plano nem monitora navegação.
- `storage`: lembrar os dados fixos da unidade (prefeitura, UBS, coordenador
  etc.) entre uma declaração e outra, salvos localmente no navegador.

## Privacidade

A extensão não transmite dados. PDFs gerados contêm dados pessoais de cidadãos
(nome, CPF, CNS) e **não devem ser versionados** — veja o `.gitignore`.

## Licença

jsPDF é distribuído sob licença MIT (ver cabeçalho de `extension/lib/jspdf.umd.min.js`).
Demais arquivos: uso interno da Secretaria Municipal de Saúde.
