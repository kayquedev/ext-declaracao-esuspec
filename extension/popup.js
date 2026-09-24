'use strict';

const DEFAULTS_KEY = 'declEnderecoDefaults';
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho',
               'agosto','setembro','outubro','novembro','dezembro'];
const LOGO_PATH = 'icons/logo_prefeitura.png';
// Máximo de visitas à família mostradas na declaração (mais recentes primeiro).
const MAX_VISITAS_EXTRAIDAS = 3;
// Cabeçalho fixo do PDF, no padrão da Secretaria Municipal de Saúde.
const CABECALHO = {
  prefeitura: 'PREFEITURA MUNICIPAL DE SÃO GONÇALO DO PARÁ – MG',
  cnpj: 'CNPJ: 18.291.369/0001-66',
  secretaria: 'Secretaria Municipal de Saúde',
  endereco: 'Av. Presidente Tancredo Neves, n 473 – Centro'
};
// Campos da unidade que o "salvar como padrão" guarda.
const CAMPOS_PADRAO = ['ubs', 'cnesUbs', 'acs', 'coordenador', 'coordenadorRegistro'];

const state = {
  members: [] // dados extraídos da página: [{nome, sexo, familia, responsavel, cns, cpf, parentesco}]
};

/* ------------------------------------------------------------------ *
 * Função injetada na aba ativa. Roda no contexto da página do e-SUS  *
 * e lê SOMENTE o texto visível em tela (nenhuma chamada de rede ou   *
 * acesso a banco de dados é feita).                                  *
 *                                                                     *
 * "Famílias e moradores" e "Últimas visitas" são abas separadas do   *
 * mesmo imóvel no e-SUS. Esta função tenta navegar sozinha entre as  *
 * duas (clicando nas abas, sem recarregar a página) para extrair as  *
 * duas de uma vez; se não conseguir localizar alguma aba (layout     *
 * mudou), simplesmente devolve o que conseguiu ler na aba atual —    *
 * o popup mescla com o que já tinha sido extraído antes.             *
 *                                                                     *
 * Precisa ser autocontida: nada de closures externas (roda isolada   *
 * dentro da página via chrome.scripting.executeScript).              *
 * ------------------------------------------------------------------ */
async function extractAllPagesData() {
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Máximo de visitas à família na declaração. Precisa ser redefinido aqui
  // (esta função roda isolada na página, sem acesso ao escopo do popup).
  const MAX_VISITAS_DECLARACAO = 3;

  function normalizar(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // Localiza o elemento clicável de uma aba pelo texto do rótulo (aceita
  // uma string ou uma lista de variantes, ex.: ["Últimas visitas",
  // "Visitas"]). Compara sem acento e sem caixa. Não depende de
  // classes/IDs, só do texto visível — resiste melhor a mudanças de
  // layout do e-SUS, mas não é garantido.
  function findTabByLabel(label) {
    const alvos = (Array.isArray(label) ? label : [label]).map(normalizar);
    const candidates = [...document.querySelectorAll('body *')].filter(el => {
      if (el.children.length > 1) return false;
      const t = normalizar(el.textContent || '');
      return alvos.some(a => t === a);
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    let el = candidates[0];
    for (let i = 0; i < 5 && el; i++) {
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'tab' || typeof el.onclick === 'function') {
        return el;
      }
      el = el.parentElement;
    }
    return candidates[0];
  }

  // Clica numa aba e espera o conteúdo da página mudar (SPA — sem
  // recarregar), com um teto de tempo para não travar a extração.
  async function clickTabAndWait(tabEl, timeoutMs) {
    const before = document.body.innerText || '';
    tabEl.click();
    const start = Date.now();
    let lastText = before;
    let stableSince = null;
    while (Date.now() - start < timeoutMs) {
      await sleep(120);
      const cur = document.body.innerText || '';
      if (cur !== lastText) { lastText = cur; stableSince = Date.now(); }
      else if (cur !== before && stableSince && Date.now() - stableSince > 200) return true;
    }
    return (document.body.innerText || '') !== before;
  }

  function parseEnderecoEMembros() {
    const text = document.body.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const result = {
      logradouro: '', numero: '', complemento: '', bairro: '',
      cidade: '', uf: '', cep: '', microarea: '',
      members: [], familiesFound: 0
    };

    // Linha "Complemento - Bairro - Cidade/UF - CEP"
    let addrLineIdx = lines.findIndex(l => /\/[A-Za-zÀ-ú]{2}\s*-\s*\d{5}-?\d{3}\s*$/.test(l));
    if (addrLineIdx === -1) {
      addrLineIdx = lines.findIndex(l => /\d{5}-?\d{3}/.test(l) && l.includes('/'));
    }

    if (addrLineIdx !== -1) {
      const parts = lines[addrLineIdx].split(' - ').map(s => s.trim()).filter(Boolean);
      const cepPart = parts[parts.length - 1] || '';
      const cepMatch = cepPart.match(/\d{5}-?\d{3}/);
      result.cep = cepMatch ? cepMatch[0] : '';

      const cityUf = parts[parts.length - 2] || '';
      const cuSplit = cityUf.split('/');
      result.cidade = (cuSplit[0] || '').trim();
      result.uf = (cuSplit[1] || '').trim().slice(0, 2).toUpperCase();

      result.bairro = parts.length >= 3 ? parts[parts.length - 3].trim() : '';
      if (parts.length >= 4) result.complemento = parts.slice(0, parts.length - 3).join(' - ').trim();

      // Título (rua/número) normalmente aparece 1-3 linhas acima
      const skipRe = /casa\/domic|apartamento|comerc|ponto estrat|escola|igreja|creche|abrigo|terreno|^outro/i;
      const labelRe = /^(microárea|telefone|geolocaliza|situação|última atualiza)/i;
      for (let i = addrLineIdx - 1; i >= Math.max(0, addrLineIdx - 4); i--) {
        const cand = lines[i];
        if (!cand || labelRe.test(cand)) continue;
        if (skipRe.test(cand) && cand.length < 30) continue;
        result._titulo = cand;
        break;
      }
    }

    if (result._titulo) {
      const m = result._titulo.match(/^(.*?),?\s*(\d+[A-Za-z]?)\s*$/);
      if (m && m[2]) { result.logradouro = m[1].trim(); result.numero = m[2].trim(); }
      else result.logradouro = result._titulo;
    }
    delete result._titulo;

    const microM = text.match(/Microárea\s*(\d+)/i);
    if (microM) result.microarea = microM[1];

    // Famílias e membros
    const familyMatches = [...text.matchAll(/Família de\s+([^\n]+)/g)];
    result.familiesFound = familyMatches.length;
    const segments = familyMatches.map((m, i) => ({
      familyName: m[1].trim(),
      start: m.index,
      end: i + 1 < familyMatches.length ? familyMatches[i + 1].index : text.length
    }));
    if (segments.length === 0) segments.push({ familyName: '', start: 0, end: text.length });

    for (const seg of segments) {
      const segText = text.slice(seg.start, seg.end);
      const memberRe = /([^\n|]{2,80}?)\s*\|\s*Sexo\s+(Masculino|Feminino)/g;
      const found = [];
      let mm;
      while ((mm = memberRe.exec(segText)) !== null) {
        found.push({ idx: mm.index, rawName: mm[1].trim(), sexo: mm[2] });
      }
      for (let i = 0; i < found.length; i++) {
        const f = found[i];
        const chunkEnd = i + 1 < found.length ? found[i + 1].idx : segText.length;
        const chunk = segText.slice(f.idx, chunkEnd);
        const before = segText.slice(Math.max(0, f.idx - 60), f.idx);
        const isResp = /Responsável familiar/i.test(before) || /Responsável familiar/i.test(f.rawName);
        const nome = f.rawName.replace(/^.*Responsável familiar\s*/i, '').trim();

        const cnsM = chunk.match(/CNS\s*([\d ]{10,25})/);
        const cpfM = chunk.match(/CPF\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
        const parM = chunk.match(/Parentesco com o responsável\s*([^\n]+)/i);

        result.members.push({
          nome,
          sexo: f.sexo,
          familia: seg.familyName,
          responsavel: isResp,
          cns: cnsM ? cnsM[1].replace(/\s+/g, '') : '',
          cpf: cpfM ? cpfM[1] : '',
          parentesco: parM ? parM[1].trim() : (isResp ? 'Responsável familiar' : '')
        });
      }
    }

    return result;
  }

  /* ------------------------- visitas domiciliares ---------------------- *
   * A aba "Últimas visitas" do e-SUS mostra uma lista em "accordion"      *
   * (data-accordion-component) — uma linha por visita ao imóvel, sem      *
   * dizer quem foi visitado. Só ao EXPANDIR a linha o e-SUS revela o      *
   * painel com "Cidadão visitado", "Data e turno", "Desfecho" e          *
   * "Motivo da visita".                                                   *
   *                                                                       *
   * ⚠ O accordion do e-SUS mantém APENAS UM item aberto por vez: abrir o  *
   * próximo fecha o anterior (e o painel dele perde o conteúdo / sai do   *
   * DOM). Portanto NÃO dá para "expandir todos e ler depois" — é preciso  *
   * expandir e LER item a item, um de cada vez.                           *
   *                                                                       *
   * A extração:                                                           *
   *   1) para cada item: expande, espera o painel carregar, lê;           *
   *   2) mantém a visita só se "Cidadão visitado" == responsável familiar *
   *      (independente de motivo/desfecho);                               *
   *   3) dentre essas, mantém só as em que "Profissional Responsável" ==  *
   *      o ACS de "Responsabilidade de acompanhamento" (a aba mostra      *
   *      visitas de outros profissionais também, mas a declaração deve    *
   *      trazer só as realizadas pelo ACS daquela família);               *
   *   4) junta o turno à data ("25/03/2026 (Noite)") e usa só o campo     *
   *      "Desfecho" na coluna de desfecho da declaração;                  *
   *   5) se o accordion não existir, ou não render nada, ou não sabermos  *
   *      o nome do responsável, cai para a leitura posicional da tabela   *
   *      sem filtrar — nunca volta vazia à toa, mas avisa na mensagem.    *
   * Extração heurística: sempre confira antes de gerar o PDF.             *
   * ---------------------------------------------------------------------*/
  async function parseVisitas(nomeResponsavel, nomeAcs) {
    const nomeNorm = normalizar(nomeResponsavel);
    const acsNorm = normalizar(nomeAcs);

    // A lista de visitas costuma carregar um instante depois da aba abrir;
    // dá até 4s para os itens do accordion aparecerem antes de desistir.
    let items = [...document.querySelectorAll('[data-accordion-component="AccordionItem"]')];
    for (let t = 0; !items.length && t < 4000; t += 150) {
      await sleep(150);
      items = [...document.querySelectorAll('[data-accordion-component="AccordionItem"]')];
    }

    // Dado um painel expandido, devolve o valor associado a um rótulo
    // (ex.: "Cidadão visitado" -> "Helena Martins Silva | Feminino"). O
    // encaixe rótulo/valor varia conforme a tela do e-SUS, então tenta,
    // em ordem: (a) o elemento IRMÃO seguinte do rótulo; (b) o irmão
    // seguinte do PAI do rótulo (rótulo e valor em colunas separadas);
    // (c) o texto do próprio container, removendo o rótulo do começo
    // (ex.: "<strong>Cidadão visitado:</strong> Helena...").
    function getLabeledValue(root, labels) {
      const alvos = (Array.isArray(labels) ? labels : [labels]).map(l => l.toLowerCase());
      for (const el of root.querySelectorAll('*')) {
        if (el.children.length !== 0) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        const low = txt.toLowerCase();
        if (!alvos.some(a => low === a || low === a + ':')) continue;

        const sib = el.nextElementSibling;
        if (sib && (sib.textContent || '').trim()) {
          return (sib.textContent || '').replace(/\s+/g, ' ').trim();
        }
        const pai = el.parentElement;
        if (pai) {
          const paiSib = pai.nextElementSibling;
          if (paiSib && (paiSib.textContent || '').trim()) {
            return (paiSib.textContent || '').replace(/\s+/g, ' ').trim();
          }
          const paiTxt = (pai.textContent || '').replace(/\s+/g, ' ').trim();
          for (const a of alvos) {
            const re = new RegExp('^' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':?\\s*', 'i');
            if (re.test(paiTxt)) {
              const resto = paiTxt.replace(re, '').trim();
              if (resto) return resto;
            }
          }
        }
      }
      return '';
    }

    const soData = (s) => { const m = (s || '').match(/(\d{2}\/\d{2}\/\d{4})/); return m ? m[1] : ''; };
    const soTurno = (s) => {
      const m = (s || '').match(/(manh[ãa]|tarde|noite)/i);
      if (!m) return '';
      const t = m[1].toLowerCase();
      return t.startsWith('manh') ? 'Manhã' : t.charAt(0).toUpperCase() + t.slice(1);
    };
    const limpaNome = (s) => {
      let n = (s || '').split('|')[0];
      n = n.replace(/\s+[-–]\s+.*$/, '');      // "Nome - Feminino" / "Nome – 45 anos"
      n = n.replace(/,\s*\d+\s*anos.*$/i, ''); // "Nome, 45 anos"
      return n.replace(/\s+/g, ' ').trim();
    };
    const dataOrdenavel = (d) => {
      const m = (d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? Number(m[3] + m[2] + m[1]) : 0;
    };

    if (items.length) {
      const rows = [];
      let algumPainelComCidadao = false;
      let algumItemComTextoDeLinha = false;
      const orcamentoMs = 35000;
      const inicio = Date.now();

      // Expande e lê UM item de cada vez — abrir o próximo fecha este.
      for (const item of items) {
        if (Date.now() - inicio > orcamentoMs) break;

        const alvoExpand =
          item.querySelector('[data-accordion-component="AccordionItemButton"]') ||
          item.querySelector('[aria-expanded]') ||
          item;
        const painelAtual = () => item.querySelector('[data-accordion-component="AccordionItemPanel"]');
        const jaAberto = () => {
          if (item.querySelector('[aria-expanded="true"]')) return true;
          const p = painelAtual();
          return !!(p && (p.textContent || '').trim().length > 20);
        };

        if (!jaAberto()) {
          alvoExpand.click();
          const t0 = Date.now();
          while (Date.now() - t0 < 3000) {
            await sleep(120);
            const p = painelAtual();
            const txt = p ? (p.textContent || '').replace(/\s+/g, ' ').trim() : '';
            if (txt.length > 20 && /(visitad|desfecho|motivo|\d{2}\/\d{2}\/\d{4})/i.test(txt)) break;
          }
          await sleep(150); // deixa o detalhe assentar (algumas telas o buscam ao expandir)
        }

        const painel = painelAtual();

        // Campo do cabeçalho por atributo name= (quando existe nessa versão).
        const getField = (name) => {
          const el = item.querySelector(`[name="${name}"]`);
          return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
        };

        let cidadaoVisitado = '', dataTurnoRaw = '', desfecho = '', motivo = '';
        if (painel) {
          cidadaoVisitado = limpaNome(getLabeledValue(painel, ['Cidadão visitado', 'Cidadao visitado']));
          dataTurnoRaw = getLabeledValue(painel, ['Data e turno', 'Data/turno', 'Data da visita']);
          desfecho = getLabeledValue(painel, ['Desfecho', 'Desfecho da visita']);
          motivo = getLabeledValue(painel, ['Motivo da visita', 'Motivos da visita', 'Motivo']);
        }
        if (cidadaoVisitado) algumPainelComCidadao = true;

        // "Profissional Responsável" é COLUNA da própria linha da tabela —
        // já visível mesmo sem expandir — e não um campo do painel
        // expandido (que só traz motivos, desfecho, cidadão visitado e
        // dados vitais). Por isso é lido do texto da linha (item),
        // excluindo o conteúdo do painel, para não confundir com o nome
        // do cidadão visitado (que fica dentro do painel).
        const rowOnlyText = (() => {
          const clone = item.cloneNode(true);
          const painelClone = clone.querySelector('[data-accordion-component="AccordionItemPanel"]');
          if (painelClone) painelClone.remove();
          return (clone.textContent || '').replace(/\s+/g, ' ').trim();
        })();
        const rowNorm = normalizar(rowOnlyText);
        if (rowOnlyText) algumItemComTextoDeLinha = true;

        const data = soData(dataTurnoRaw) || getField('dataVisita') || soData(item.textContent || '');
        const turno = soTurno(dataTurnoRaw) || soTurno(item.textContent || '');
        desfecho = desfecho || getField('desfecho');
        motivo = motivo || getField('motivoVisita');

        if (data || desfecho || motivo) {
          const cidadaoNorm = normalizar(cidadaoVisitado);
          const doResponsavel = !!(
            nomeNorm && cidadaoNorm && (
              cidadaoNorm === nomeNorm ||
              (nomeNorm.length >= 6 && cidadaoNorm.includes(nomeNorm)) ||
              (cidadaoNorm.length >= 6 && nomeNorm.includes(cidadaoNorm))
            )
          );
          // O nome do ACS aparece literalmente na linha (coluna
          // "Profissional Responsável"); basta checar se ele consta no
          // texto da linha (já sem o painel).
          const doProfissional = !!(
            acsNorm && rowNorm && acsNorm.length >= 6 && rowNorm.includes(acsNorm)
          );
          rows.push({ data, turno, desfecho, motivo, cidadaoVisitado, doResponsavel, doProfissional });
        }
      }

      // "Desfecho Visita" da declaração = só o campo Desfecho do e-SUS
      // (ex.: "Visita realizada"); usa o motivo apenas se o desfecho vier
      // vazio, para a linha não ficar em branco.
      const montar = (v) => ({
        data: v.turno ? `${v.data} (${v.turno})` : v.data,
        desfecho: v.desfecho || v.motivo || ''
      });

      // No e-SUS, visitar "a família" recai no responsável familiar e a
      // visita "à pessoa" (o próprio responsável) também — então a mesma
      // visita aparece duas vezes no mesmo dia/turno, para o mesmo
      // cidadão. Colapsa essas duplicatas em uma só. Linhas sem "Cidadão
      // visitado" identificado não são colapsadas (não dá para afirmar
      // que são a mesma visita).
      const semDuplicatas = (lista) => {
        const vistos = new Set();
        const saida = [];
        lista.forEach((v, i) => {
          const cid = normalizar(v.cidadaoVisitado || '');
          const chave = cid
            ? `${v.data}|${normalizar(v.turno || '')}|${cid}`
            : `__linha_${i}__`;
          if (vistos.has(chave)) return;
          vistos.add(chave);
          saida.push(v);
        });
        return saida;
      };

      // Só confia no filtro por "Cidadão visitado" (inclusive quando dá
      // zero) se ao menos um painel trouxe esse campo E sabemos o nome do
      // responsável. Senão devolve todas as visitas do imóvel, sem
      // filtrar, sinalizando para o popup avisar.
      if (rows.length && algumPainelComCidadao && nomeNorm) {
        let doResp = rows.filter(r => r.doResponsavel);

        // Dentre as visitas ao responsável familiar, restringe também ao
        // ACS de "Responsabilidade de acompanhamento": a aba "Últimas
        // visitas" traz visitas de outros profissionais, mas a declaração
        // deve trazer só as realizadas pelo ACS daquela família. Só aplica
        // se conseguimos ler o texto da linha e ele reduzir a lista sem
        // zerá-la (senão mantém o filtro anterior, avisando para conferir).
        if (algumItemComTextoDeLinha && acsNorm) {
          const doAcs = doResp.filter(r => r.doProfissional);
          if (doAcs.length) doResp = doAcs;
        }

        doResp.sort((a, b) => dataOrdenavel(b.data) - dataOrdenavel(a.data));
        return {
          visitas: semDuplicatas(doResp).slice(0, MAX_VISITAS_DECLARACAO).map(montar),
          filtradoPorResponsavel: true
        };
      }
      if (rows.length) {
        rows.sort((a, b) => dataOrdenavel(b.data) - dataOrdenavel(a.data));
        return {
          visitas: semDuplicatas(rows).slice(0, MAX_VISITAS_DECLARACAO).map(montar),
          filtradoPorResponsavel: false
        };
      }
      // accordion presente mas nada legível: cai para a leitura da tabela.
    }

    // Sem accordion utilizável: leitura posicional da tabela. Filtra pelo
    // ACS de "Responsabilidade de acompanhamento" quando a coluna
    // "Profissional Responsável" está disponível; senão devolve sem
    // filtrar (heurística — sempre conferir antes de gerar o PDF).
    return { visitas: parseVisitasDaTabela(acsNorm), filtradoPorResponsavel: false };
  }

  function parseVisitasDaTabela(acsNorm) {
    const text = document.body.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Localiza o cabeçalho "Data da visita" / "Desfecho" / "Motivo da visita"
    // (nesta ordem, uma linha cada) para achar onde a tabela começa.
    let headerIdx = -1;
    for (let i = 0; i < lines.length - 2; i++) {
      if (/^Data da visita$/i.test(lines[i]) &&
          /^Desfecho$/i.test(lines[i + 1]) &&
          /^Motivo da visita$/i.test(lines[i + 2])) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) return [];

    // Pula eventuais colunas extras do cabeçalho (Profissional Responsável,
    // Equipe, Origem etc.) até chegar nos dados da primeira linha, anotando
    // em que posição (relativa ao início de cada linha de dados) cada uma
    // aparece, para poder ler o mesmo valor em cada registro.
    let dataStart = headerIdx + 3;
    const extraHeaderLabels = ['Profissional Responsável', 'Equipe', 'Origem'];
    const extraHeadersFound = [];
    while (dataStart < lines.length &&
           extraHeaderLabels.map(normalizar).includes(normalizar(lines[dataStart]))) {
      extraHeadersFound.push(lines[dataStart]);
      dataStart++;
    }
    const idxProfissional = extraHeadersFound.findIndex(
      h => normalizar(h) === normalizar('Profissional Responsável')
    );

    const dateLineRe = /^\d{2}\/\d{2}\/\d{4}$/;
    // Marca o fim da tabela (paginação/rodapé: "10 resultados", "Mostrar:50",
    // "de 1", "Expandir" etc.) para não capturar lixo depois dela.
    const endMarkerRe = /resultados\s*$|^Mostrar\s*:|^de\s+\d+$|^Expandir$/i;

    const rowStarts = [];
    let tableEnd = lines.length;
    for (let i = dataStart; i < lines.length; i++) {
      if (endMarkerRe.test(lines[i])) { tableEnd = i; break; }
      if (dateLineRe.test(lines[i])) rowStarts.push(i);
    }

    const camposPorLinha = 3 + extraHeadersFound.length;
    const rows = [];
    for (let r = 0; r < rowStarts.length; r++) {
      const start = rowStarts[r];
      const data = lines[start];
      const desfecho = (lines[start + 1] || '').trim();
      const motivo = (lines[start + 2] || '').trim();
      const profissionalVisita = idxProfissional >= 0
        ? (lines[start + 3 + idxProfissional] || '').trim()
        : '';
      if (start + (camposPorLinha - 1) < tableEnd) {
        rows.push({ data, desfecho, motivo, profissionalVisita });
      }
    }

    function dataOrdenavel(d) {
      const m = (d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? Number(m[3] + m[2] + m[1]) : 0;
    }

    // Filtra pelo ACS responsável quando a coluna "Profissional Responsável"
    // existe na tabela e conseguimos ler o valor em pelo menos uma linha;
    // se isso zerar a lista (nada bate), mantém tudo, sem filtrar.
    let filtradas = rows;
    if (idxProfissional >= 0 && acsNorm && rows.some(r => r.profissionalVisita)) {
      const doAcs = rows.filter(r => {
        const profNorm = normalizar(r.profissionalVisita || '');
        return !!(profNorm && (
          profNorm === acsNorm ||
          (acsNorm.length >= 6 && profNorm.includes(acsNorm)) ||
          (profNorm.length >= 6 && acsNorm.includes(profNorm))
        ));
      });
      if (doAcs.length) filtradas = doAcs;
    }

    filtradas.sort((a, b) => dataOrdenavel(b.data) - dataOrdenavel(a.data));

    // Coluna "Desfecho Visita" da declaração = só o campo Desfecho do
    // e-SUS ("Visita realizada" etc.); usa o motivo apenas se o desfecho
    // vier vazio, para a linha não ficar em branco.
    return filtradas.slice(0, MAX_VISITAS_DECLARACAO).map(v => ({
      data: v.data,
      desfecho: v.desfecho || v.motivo || ''
    }));
  }

  /* --------------- ACS responsável pelo acompanhamento --------------- *
   * Na aba "Informações cadastrais" do imóvel existe a seção            *
   * "Responsabilidade de acompanhamento", com um cartão por            *
   * profissional: nome, e pares rótulo/valor "CBO", "Equipe",          *
   * "Unidade de saúde". Pega o nome do cartão cujo CBO é "Agente       *
   * comunitário de saúde". As classes CSS do e-SUS são hash e mudam a  *
   * cada build, então tudo aqui se apoia em TEXTO fixo.                *
   * ---------------------------------------------------------------- */
  function parseResponsavelAcompanhamento() {
    const ehRotulo = (t) => /^(CBO|Equipe|Unidade de sa[úu]de)$/i.test(t);
    const pareceNome = (s) => {
      const t = (s || '').replace(/\s+/g, ' ').trim();
      return /^[\p{Lu}][\p{L}'.-]+(?:\s+[\p{L}'.-]+){1,5}$/u.test(t) &&
        !ehRotulo(t) &&
        !/responsabilidade de acompanhamento/i.test(t) &&
        !/^(Agente|M[ée]dico|Enfermeiro|T[ée]cnico|Cirurgi|Dentista|ACS|ACE)\b/i.test(t);
    };

    const folhas = (root) => [...root.querySelectorAll('*')].filter(x => x.children.length === 0);

    // Escopo: sobe do título da seção até um ancestral que contenha "CBO".
    const titulo = folhas(document).find(
      x => (x.textContent || '').replace(/\s+/g, ' ').trim() === 'Responsabilidade de acompanhamento'
    );
    let escopo = document.body;
    if (titulo) {
      let el = titulo.parentElement;
      for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
        if (folhas(el).some(x => (x.textContent || '').trim() === 'CBO')) { escopo = el; break; }
      }
    }

    const cboLabels = folhas(escopo).filter(x => (x.textContent || '').trim() === 'CBO');
    for (const lbl of cboLabels) {
      const val = lbl.nextElementSibling
        ? (lbl.nextElementSibling.textContent || '').replace(/\s+/g, ' ').trim()
        : '';
      if (!/agente\s+comunit[áa]rio/i.test(val)) continue;

      // Sobe até o cartão do profissional (ancestral com exatamente um
      // "CBO" e algum nome). Para antes de englobar o título da seção ou
      // um segundo cartão.
      let card = lbl.parentElement;
      for (let i = 0; i < 6 && card; i++, card = card.parentElement) {
        if (titulo && card.contains(titulo)) break;
        const qtdCbo = folhas(card).filter(x => (x.textContent || '').trim() === 'CBO').length;
        if (qtdCbo > 1) break; // subiu demais, juntou cartões
        const nome = folhas(card).map(x => (x.textContent || '').replace(/\s+/g, ' ').trim()).find(pareceNome);
        if (nome) return nome;
      }
    }

    // Fallback: regex sobre o texto do escopo ("<nome>CBOAgente comunitário…").
    const txt = (escopo.textContent || '').replace(/\s+/g, ' ').trim();
    const m = txt.match(/([\p{Lu}][\p{L}'.-]+(?:\s+[\p{L}'.-]+){1,5})\s*CBO\s*Agente\s+comunit[áa]rio/u);
    if (m) {
      const nome = m[1].replace(/^.*Responsabilidade de acompanhamento\s*/i, '').trim();
      if (pareceNome(nome)) return nome;
    }
    return '';
  }

  // 1) Garante que estamos vendo "Famílias e moradores" e extrai
  //    endereço + moradores. Se a aba atual já não tiver nada disso,
  //    tenta clicar na aba correspondente.
  let base = parseEnderecoEMembros();
  const tabFamilias = findTabByLabel(['Famílias e moradores', 'Família e moradores', 'Moradores']);
  // O cabeçalho com o endereço do imóvel fica visível em qualquer aba (é a
  // lista de moradores que só aparece dentro de "Famílias e moradores"),
  // então o sinal de que ainda falta navegar até lá é não ter moradores —
  // não a falta de endereço, que já vem de qualquer aba.
  if (!base.members.length && tabFamilias) {
    await clickTabAndWait(tabFamilias, 4000);
    base = parseEnderecoEMembros();
  }

  const responsavel = base.members.find(m => m.responsavel) || base.members[0];
  const nomeResponsavel = responsavel ? responsavel.nome : '';

  // 1b) Lê o ACS de "Responsabilidade de acompanhamento" na aba
  //     "Informações cadastrais" (navega até lá se ainda não estiver
  //     vendo essa seção).
  let acsResponsavel = parseResponsavelAcompanhamento();
  if (!acsResponsavel) {
    const tabInfo = findTabByLabel(['Informações cadastrais', 'Informações do cadastro', 'Informações']);
    if (tabInfo) {
      await clickTabAndWait(tabInfo, 4000);
      acsResponsavel = parseResponsavelAcompanhamento();
    }
  }
  base.acs = acsResponsavel;

  // 2) Navega para "Últimas visitas", expande cada item e extrai só as
  //    visitas do(a) responsável familiar feitas pelo ACS de
  //    "Responsabilidade de acompanhamento" (até 6, mais recentes primeiro).
  let visitas = [];
  let filtradoPorResponsavel = false;
  const tabVisitas = findTabByLabel(['Últimas visitas', 'Visitas', 'Histórico de visitas']);
  if (tabVisitas) {
    await clickTabAndWait(tabVisitas, 4000);
    const resultado = await parseVisitas(nomeResponsavel, acsResponsavel);
    visitas = resultado.visitas;
    filtradoPorResponsavel = resultado.filtradoPorResponsavel;

    // Volta para "Famílias e moradores" para deixar a página como estava.
    const tabFamiliasVolta = findTabByLabel(['Famílias e moradores', 'Família e moradores', 'Moradores']);
    if (tabFamiliasVolta) await clickTabAndWait(tabFamiliasVolta, 4000);
  }

  base.visitas = visitas;
  base.filtradoPorResponsavel = filtradoPorResponsavel;
  // Distingue "a aba foi lida e não há visitas" de "não conseguiu chegar
  // na aba" — só no primeiro caso o popup limpa a tabela de visitas.
  base.abaVisitasLida = !!tabVisitas;
  return base;
}

/* ---------------------------- utilidades --------------------------- */

function $(id) { return document.getElementById(id); }

function slug(s) {
  return (s || 'documento')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'documento';
}

function dateExtenso(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${String(d).padStart(2, '0')} de ${MESES[m - 1]} de ${y}`;
}

function setStatus(msg, isError) {
  const el = $('extractStatus');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
}

// Tag verde no cabeçalho, mostrada só quando a extração da tela terminou
// com algum dado reconhecido.
function setFinalizado(show) {
  const el = $('finalizadoBadge');
  if (el) el.hidden = !show;
}

/* ------------------------ tabelas dinâmicas ------------------------- */

function addRow(tableId, values, placeholders) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  const tr = document.createElement('tr');
  placeholders.forEach((ph, i) => {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = ph;
    input.value = values && values[i] ? values[i] : '';
    td.appendChild(input);
    tr.appendChild(td);
  });
  const tdBtn = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-remove';
  btn.textContent = '✕';
  btn.title = 'Remover linha';
  btn.addEventListener('click', () => tr.remove());
  tdBtn.appendChild(btn);
  tr.appendChild(tdBtn);
  tbody.appendChild(tr);
  return tr;
}

function addMoradorRow(values) {
  return addRow('moradoresTable', values, ['Nome completo', 'CPF ou CNS', 'Parentesco']);
}

function addVisitaRow(values) {
  return addRow('visitasTable', values, ['DD/MM/AAAA', 'Desfecho da visita']);
}

function readTable(tableId) {
  const rows = [...document.querySelectorAll(`#${tableId} tbody tr`)];
  return rows.map(tr => [...tr.querySelectorAll('input')].map(i => i.value.trim()));
}

function clearTable(tableId) {
  document.querySelector(`#${tableId} tbody`).innerHTML = '';
}

/* --------------------------- extração ------------------------------ */

// Durante a extração some o botão Extrair e aparece o aviso vermelho para
// o usuário não mexer no e-SUS enquanto a extensão navega entre as abas.
function setExtraindo(ativo) {
  $('btnExtract').hidden = ativo;
  $('btnExtract').disabled = ativo;
  $('extractingBox').hidden = !ativo;
}

async function handleExtract() {
  setFinalizado(false);
  setStatus('');
  setExtraindo(true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('Nenhuma aba ativa encontrada.');

    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAllPagesData
    });
    const data = injection && injection[0] && injection[0].result;
    if (!data) throw new Error('Não foi possível ler a página.');

    // A extração já tenta sozinha navegar entre "Famílias e moradores" e
    // "Últimas visitas" dentro da mesma execução. Mesmo assim, o
    // preenchimento aqui continua aditivo (só sobrescreve o que foi
    // encontrado desta vez) como rede de segurança: se o layout do e-SUS
    // mudar e a navegação automática falhar, dá para navegar manualmente
    // e clicar em Extrair de novo sem perder o que já tinha sido puxado.
    const foundAddress = !!(data.logradouro || data.cidade || data.bairro || data.cep);
    const foundMembers = (data.members || []).length > 0;
    const visitas = (data.visitas || []).slice(0, MAX_VISITAS_EXTRAIDAS);
    const foundVisitas = visitas.length > 0;

    if (foundAddress) {
      $('logradouro').value = data.logradouro || '';
      $('numero').value = data.numero || '';
      $('complemento').value = data.complemento || '';
      $('bairro').value = data.bairro || '';
      $('cidade').value = data.cidade || '';
      $('uf').value = data.uf || '';
      $('cep').value = data.cep || '';
      if (!$('cidadeDeclaracao').value) $('cidadeDeclaracao').value = data.cidade || '';
      if (!$('ufDeclaracao').value) $('ufDeclaracao').value = data.uf || '';
    }
    if (data.microarea && !$('microarea').value) $('microarea').value = data.microarea;

    // ACS: nome lido de "Responsabilidade de acompanhamento" (aba
    // "Informações cadastrais"), cartão com CBO "Agente comunitário de
    // saúde". Sobrescreve o campo quando encontrado — é justamente o dado
    // que muda a cada declaração.
    const foundAcs = !!(data.acs && data.acs.trim());
    if (foundAcs) $('acs').value = data.acs.trim();

    if (foundMembers) {
      state.members = data.members;
      const select = $('primaryMemberSelect');
      select.innerHTML = '';
      state.members.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        const famTag = data.familiesFound > 1 && m.familia ? ` — ${m.familia}` : '';
        opt.textContent = `${m.nome}${m.responsavel ? ' (responsável)' : ''}${famTag}`;
        select.appendChild(opt);
      });
      const defaultIdx = state.members.findIndex(m => m.responsavel);
      select.value = String(defaultIdx !== -1 ? defaultIdx : 0);
      applyPrimaryMember();
    }

    // Visitas: lidas da tabela de "Últimas visitas" do imóvel (até 6, mais
    // recentes primeiro). Só substitui a tabela se algo foi encontrado,
    // para não apagar entradas manuais existentes.
    // Se a aba foi lida e não há visitas, esvazia a tabela: o PDF então
    // imprime o aviso de que não existem visitas ao responsável familiar.
    if (foundVisitas) {
      clearTable('visitasTable');
      visitas.forEach(v => addVisitaRow([v.data || '', v.desfecho || '']));
    } else if (data.abaVisitasLida) {
      clearTable('visitasTable');
    }

    const parts = [];
    if (foundAddress) parts.push('endereço');
    if (foundAcs) parts.push(`ACS ${data.acs.trim()}`);
    if (foundMembers) parts.push(`${state.members.length} morador(es)`);
    if (!foundVisitas && data.abaVisitasLida) {
      parts.push('nenhuma visita ao responsável familiar (o PDF trará o aviso)');
    }
    if (foundVisitas) {
      parts.push(data.filtradoPorResponsavel
        ? `${visitas.length} visita(s) do(a) responsável familiar`
        : `${visitas.length} visita(s) ao imóvel (não foi possível confirmar qual morador — confira)`);
    }

    let statusMsg;
    let isError = false;
    if (parts.length) {
      statusMsg = `Extraído: ${parts.join(', ')}. Se faltar algo (a navegação automática entre as páginas pode falhar se o e-SUS mudar de layout), abra a página que faltou e clique em Extrair de novo — os dados são somados. Confira antes de gerar o PDF.`;
    } else {
      statusMsg = 'Nenhum dado reconhecido. Abra a aba "Famílias e moradores" do e-SUS e tente novamente, ou preencha manualmente. Dados extraídos anteriormente foram mantidos.';
      isError = true;
    }
    setStatus(statusMsg, isError);
    setFinalizado(parts.length > 0);
  } catch (err) {
    console.error(err);
    setFinalizado(false);
    setStatus('Erro ao extrair: ' + err.message + '. Verifique se a página do e-SUS está aberta na aba ativa.', true);
  } finally {
    setExtraindo(false);
  }
}

function applyPrimaryMember() {
  const idx = Number($('primaryMemberSelect').value);
  const member = state.members[idx];
  if (!member) return;

  $('usuarioNome').value = member.nome || '';
  $('usuarioCpf').value = member.cpf || '';
  $('usuarioCns').value = member.cns || '';

  clearTable('moradoresTable');
  state.members.forEach((m, i) => {
    if (i === idx) return;
    addMoradorRow([m.nome, m.cpf || m.cns || '', m.parentesco || '']);
  });
}

/* --------------------------- brasão / marca d'água -------------------- */

let logoPromise = null;

function loadLogo() {
  if (!logoPromise) {
    logoPromise = (async () => {
      try {
        const url = chrome.runtime.getURL(LOGO_PATH);
        const res = await fetch(url);
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
        const dims = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = reject;
          img.src = dataUrl;
        });
        return { dataUrl, w: dims.w, h: dims.h };
      } catch (err) {
        console.warn('Não foi possível carregar o brasão da prefeitura:', err);
        return null;
      }
    })();
  }
  return logoPromise;
}

function drawWatermark(doc, logo, pageWidth, pageHeight) {
  if (!logo) return;
  const targetW = pageWidth * 0.95;
  const targetH = targetW * (logo.h / logo.w);
  const x = (pageWidth - targetW) / 2;
  const y = (pageHeight - targetH) / 2;
  doc.saveGraphicsState();
  doc.setGState(new doc.GState({ opacity: 0.1 }));
  doc.addImage(logo.dataUrl, 'PNG', x, y, targetW, targetH);
  doc.restoreGraphicsState();
}

/* --------------------------- geração PDF ----------------------------- */

function writeJustifiedParagraph(doc, segments, x, y, maxWidth, lineHeight, fontSize) {
  doc.setFontSize(fontSize);
  const words = [];
  segments.forEach(seg => {
    if (!seg.text) return;
    seg.text.split(/\s+/).filter(Boolean).forEach(w => words.push({ text: w, bold: !!seg.bold }));
  });
  // Um token que é só pontuação (ex.: "," entre dois segmentos com espaço
  // antes) não deve virar palavra própria — gruda no token anterior para
  // não abrir um espaço indevido antes da vírgula/ponto.
  for (let i = words.length - 1; i >= 1; i--) {
    if (/^[,.;:!?)]+$/.test(words[i].text)) {
      words[i - 1].text += words[i].text;
      words.splice(i, 1);
    }
  }

  function wWidth(w) {
    doc.setFont('helvetica', w.bold ? 'bold' : 'normal');
    return doc.getTextWidth(w.text);
  }

  doc.setFont('helvetica', 'normal');
  const spaceWidth = doc.getTextWidth(' ');

  const lines = [];
  let current = [];
  let curWidth = 0;
  words.forEach(w => {
    const ww = wWidth(w);
    const extra = current.length ? spaceWidth : 0;
    if (curWidth + extra + ww > maxWidth && current.length) {
      lines.push(current);
      current = [w];
      curWidth = ww;
    } else {
      current.push(w);
      curWidth += extra + ww;
    }
  });
  if (current.length) lines.push(current);

  let cy = y;
  lines.forEach((line, li) => {
    const isLast = li === lines.length - 1;
    const wordsWidth = line.reduce((s, w) => s + wWidth(w), 0);
    const gaps = line.length - 1;
    const gapWidth = (!isLast && gaps > 0) ? (maxWidth - wordsWidth) / gaps : spaceWidth;

    let cx = x;
    line.forEach((w, wi) => {
      doc.setFont('helvetica', w.bold ? 'bold' : 'normal');
      doc.text(w.text, cx, cy);
      cx += wWidth(w) + (wi < line.length - 1 ? gapWidth : 0);
    });
    cy += lineHeight;
  });
  doc.setFont('helvetica', 'normal');
  return cy;
}

function drawTable(doc, x, y, width, headers, rows, colRatios, minRows) {
  const rowH = 7;
  const headerH = 6.5;
  const colWidths = colRatios.map(r => r * width);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.rect(x, y, width, headerH);
  let cx = x;
  headers.forEach((h, i) => {
    doc.text(h, cx + 2, y + headerH - 2.2, { maxWidth: colWidths[i] - 3 });
    cx += colWidths[i];
  });
  cx = x;
  colWidths.forEach(w => { doc.line(cx, y, cx, y + headerH); cx += w; });
  doc.line(x + width, y, x + width, y + headerH);
  y += headerH;

  const total = Math.max(rows.length, minRows);
  doc.setFont('helvetica', 'normal');
  for (let r = 0; r < total; r++) {
    const rowData = rows[r] || headers.map(() => '');
    doc.rect(x, y, width, rowH);
    cx = x;
    rowData.forEach((val, i) => {
      doc.text(String(val || ''), cx + 2, y + rowH - 2.5, { maxWidth: colWidths[i] - 3 });
      cx += colWidths[i];
    });
    cx = x;
    colWidths.forEach(w => { doc.line(cx, y, cx, y + rowH); cx += w; });
    doc.line(x + width, y, x + width, y + rowH);
    y += rowH;
  }
  return y;
}

// Campos derivados dos dados do formulário, comuns ao PDF e ao texto da
// aba "Orientações": endereço completo, documento, UBS (com CNES) e as
// linhas já filtradas de moradores/visitas.
function prepararDeclaracao(d) {
  const enderecoPrincipal = [d.logradouro, d.numero ? `nº ${d.numero}` : ''].filter(Boolean).join(', ');
  const complBairro = [d.complemento, d.bairro].filter(Boolean).join(', ');
  const cidadeUf = [d.cidade, d.uf].filter(Boolean).join('/');
  const enderecoCompleto = [enderecoPrincipal, complBairro, cidadeUf].filter(Boolean).join(', ');

  let docLabel = '';
  if (d.usuarioCpf && d.usuarioCns) docLabel = `CPF ${d.usuarioCpf} / CNS ${d.usuarioCns}`;
  else if (d.usuarioCpf) docLabel = `CPF ${d.usuarioCpf}`;
  else if (d.usuarioCns) docLabel = `CNS ${d.usuarioCns}`;

  // "UBS CENTRAL (CNES 1234567)" — os parênteses só entram se o CNES foi preenchido.
  const ubsTexto = d.ubs ? `${d.ubs}${d.cnesUbs ? ` (CNES ${d.cnesUbs})` : ''}` : '';
  const moradoresPreenchidos = d.moradores.filter(r => r.some(v => v));
  const visitas = d.visitas.filter(r => r.some(v => v));
  const local = [d.cidadeDeclaracao, d.ufDeclaracao].filter(Boolean).join(', ');

  return { enderecoCompleto, docLabel, secretariaNome: CABECALHO.secretaria, ubsTexto, moradoresPreenchidos, visitas, local };
}

async function generatePdf(d) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 20;
  const maxWidth = pageWidth - marginX * 2;
  let y = 18;

  // Marca d'água do brasão da prefeitura, centralizada e atrás do texto
  // (mesmo tratamento do modelo oficial da Secretaria).
  const logo = await loadLogo();
  drawWatermark(doc, logo, pageWidth, pageHeight);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(CABECALHO.prefeitura, pageWidth / 2, y, { align: 'center' });
  y += 5.5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  [CABECALHO.cnpj, CABECALHO.secretaria, CABECALHO.endereco].forEach(t => {
    doc.text(t, pageWidth / 2, y, { align: 'center' });
    y += 5;
  });

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('DECLARAÇÃO DE ENDEREÇO', pageWidth / 2, y, { align: 'center' });
  y += 12;

  const { enderecoCompleto, docLabel, secretariaNome, ubsTexto, moradoresPreenchidos, visitas, local } = prepararDeclaracao(d);

  // Texto no mesmo formato do modelo oficial: "Declaro, para os devidos
  // fins, junto à [Secretaria], que o(a) usuário [NOME], CPF/CNS [DOC],
  // reside à [ENDEREÇO]. O endereço acima citado é de abrangência da
  // Unidade Básica de Saúde da [UBS] e o(a) morador(a) é usuário(a) do
  // serviço aqui prestado, e acompanhado pelo Agente Comunitário de Saúde
  // [ACS], Microárea [MA]."
  const seg1 = [
    { text: `Declaro, para os devidos fins, junto à ${secretariaNome}, que o(a) usuário` },
    { text: ` ${d.usuarioNome}`, bold: true },
    docLabel ? { text: `, ${docLabel},` } : { text: ',' },
    { text: ` reside à ${enderecoCompleto}. O endereço acima citado é de abrangência da Unidade Básica de Saúde da` },
    ubsTexto ? { text: ` ${ubsTexto}`, bold: true } : null,
    { text: ` e o(a) morador(a) é usuário(a) do serviço aqui prestado, e acompanhado pelo Agente Comunitário de Saúde` },
    d.acs ? { text: ` ${d.acs}`, bold: true } : null,
    { text: `${d.microarea ? ', Microárea ' + d.microarea : ''}.` }
  ].filter(Boolean);

  y = writeJustifiedParagraph(doc, seg1, marginX, y, maxWidth, 6, 11);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('Também residem neste endereço, os seguintes moradores:', marginX, y);
  y += 4;
  if (moradoresPreenchidos.length === 0) {
    // Sem mais nenhum morador além do responsável familiar: não desenha a
    // tabela de 3 colunas (Nome/Documento/Parentesco), só o aviso.
    doc.setFont('helvetica', 'bold');
    doc.text('NÃO RESIDE MAIS NENHUM MORADOR', marginX, y);
    doc.setFont('helvetica', 'normal');
    y += 6;
  } else {
    // minRows = quantidade real de moradores, para nunca sobrar linha em
    // branco na tabela (1 morador = 1 linha, 2 = 2 linhas, etc.).
    y = drawTable(
      doc, marginX, y, maxWidth,
      ['Nome Completo', 'Nº do Documento (CPF/CNS)', 'Relação de Parentesco'],
      moradoresPreenchidos,
      [0.45, 0.30, 0.25], moradoresPreenchidos.length
    );
  }
  y += 8;

  doc.text('Últimas visitas realizadas à família:', marginX, y);
  y += 4;
  if (visitas.length === 0) {
    // Nenhuma visita ao responsável familiar: não desenha a tabela, só o
    // aviso (mesmo tratamento da tabela de moradores).
    doc.setFont('helvetica', 'bold');
    doc.text('NÃO EXISTEM REGISTROS DE VISITAS AO RESPONSÁVEL FAMILIAR NESTE ENDEREÇO', marginX, y, { maxWidth });
    doc.setFont('helvetica', 'normal');
    y += 6;
  } else {
    // minRows = quantidade real de visitas (até 3), para nunca sobrar linha
    // em branco na tabela.
    y = drawTable(
      doc, marginX, y, maxWidth,
      ['Data da Visita', 'Desfecho Visita'],
      visitas, [0.28, 0.72], visitas.length
    );
  }
  y += 10;

  doc.setFontSize(11);
  doc.text('Para clareza e por ser verdade, firmo a presente declaração.', marginX, y);
  y += 10;
  doc.text(`${local}, ${d.dataExtenso}.`, marginX, y);
  y += 22;

  const gap = 10;
  const sigWidth = (maxWidth - gap) / 2;
  doc.line(marginX, y, marginX + sigWidth, y);
  doc.line(marginX + sigWidth + gap, y, marginX + sigWidth * 2 + gap, y);
  y += 5;
  doc.setFontSize(9.5);
  doc.text(d.acs ? `ACS ${d.acs}` : 'ACS Responsável', marginX + sigWidth / 2, y, { align: 'center' });
  const coordX = marginX + sigWidth + gap + sigWidth / 2;
  // Por padrão (nome e COREN em branco) imprime só o cargo, para o nome e o
  // COREN serem preenchidos à mão/carimbo. Se preenchidos no popup, entram
  // abaixo do cargo.
  doc.text('Enfermeiro(a) e Coordenador(a) da Unidade', coordX, y, { align: 'center' });
  const coordLinhas = [d.coordenador, d.coordenadorRegistro].filter(Boolean);
  coordLinhas.forEach((t, i) => doc.text(t, coordX, y + 4 * (i + 1), { align: 'center' }));

  doc.save(`Declaracao_Endereco_${slug(d.usuarioNome)}.pdf`);
}

/* ------------------------------ eventos ------------------------------ */

async function loadDefaults() {
  const stored = await chrome.storage.local.get(DEFAULTS_KEY);
  const def = stored[DEFAULTS_KEY];
  if (!def) return;
  // Nome/COREN da enfermeira que vinham fixos em versões anteriores: se
  // ficaram salvos como padrão, descarta para o campo voltar em branco.
  if (/^maryana vieira rodrigues$/i.test(def.coordenador || '')) def.coordenador = '';
  if (/810320/.test(def.coordenadorRegistro || '')) def.coordenadorRegistro = '';
  CAMPOS_PADRAO.forEach(id => { if (def[id]) $(id).value = def[id]; });
}

async function saveDefaults() {
  const def = {};
  CAMPOS_PADRAO.forEach(id => { def[id] = $(id).value.trim(); });
  await chrome.storage.local.set({ [DEFAULTS_KEY]: def });
  setStatus('Padrões da unidade salvos para as próximas declarações.');
}

// Lê todos os campos do formulário (usado tanto para o PDF quanto para o
// texto copiado para "Orientações").
function collectFormData() {
  return {
    ubs: $('ubs').value.trim(),
    cnesUbs: $('cnesUbs').value.trim(),
    acs: $('acs').value.trim(),
    coordenador: $('coordenador').value.trim(),
    coordenadorRegistro: $('coordenadorRegistro').value.trim(),
    usuarioNome: $('usuarioNome').value.trim(),
    usuarioCpf: $('usuarioCpf').value.trim(),
    usuarioCns: $('usuarioCns').value.trim(),
    microarea: $('microarea').value.trim(),
    logradouro: $('logradouro').value.trim(),
    numero: $('numero').value.trim(),
    complemento: $('complemento').value.trim(),
    bairro: $('bairro').value.trim(),
    cidade: $('cidade').value.trim(),
    uf: $('uf').value.trim(),
    cep: $('cep').value.trim(),
    moradores: readTable('moradoresTable'),
    visitas: readTable('visitasTable'),
    cidadeDeclaracao: $('cidadeDeclaracao').value.trim(),
    ufDeclaracao: $('ufDeclaracao').value.trim(),
    dataExtenso: dateExtenso($('dataDeclaracao').value)
  };
}

// Validação mínima comum ao gerar PDF e ao copiar para "Orientações".
function validarFormulario() {
  if (!$('usuarioNome').value.trim()) {
    setStatus('Informe o nome do(a) usuário(a) da declaração.', true);
    $('usuarioNome').focus();
    return false;
  }
  if (!dateExtenso($('dataDeclaracao').value)) {
    setStatus('Informe a data da declaração.', true);
    return false;
  }
  return true;
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (!validarFormulario()) return;
  const data = collectFormData();
  try {
    setStatus('Gerando PDF…');
    await generatePdf(data);
    setStatus('PDF gerado com sucesso.');
  } catch (err) {
    console.error(err);
    setStatus('Erro ao gerar o PDF: ' + err.message, true);
  }
}

/* --------------------- texto para a aba "Orientações" ---------------- */

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// A aba "Orientações" do e-SUS é um campo de texto rico, mas testado
// manualmente contra o campo real: dentro de um único parágrafo, <br><br>
// é a forma confirmada de abrir linha em branco de verdade — por isso os
// títulos/parágrafo/frase de fechamento ficam num <p> só, com esse
// espaçamento exatamente nos pontos marcados pelo usuário (antes de cada
// título/frase, 4x seguidos antes da linha de assinatura) e só 1 <br>
// simples no resto (título -> conteúdo logo abaixo, linha de assinatura
// -> nome do ACS). Moradores e visitas usam <ul>/<li> de verdade (também
// confirmado colando certo) como blocos à parte, entre esses parágrafos —
// <ul> não pode ficar dentro de <p>. Não inclui cabeçalho da prefeitura
// nem data (a aba já tem o próprio timbre e já gera a data automaticamente
// ao salvar) nem a assinatura do(a) enfermeiro(a): a aba assina sozinha
// com quem estiver logado ao salvar, então só o ACS entra no texto.
function buildOrientacoesConteudo(d) {
  const p = prepararDeclaracao(d);
  const acsTexto = d.acs ? `ACS ${d.acs}` : 'ACS Responsável';
  const docTexto = p.docLabel ? `, ${p.docLabel},` : ',';
  const acsFraseTexto = d.acs ? ` ${d.acs}` : '';
  const microareaTexto = d.microarea ? `, Microárea ${d.microarea}` : '';
  const paragrafo = `Declaro, para os devidos fins, junto à ${p.secretariaNome}, que o(a) usuário ${d.usuarioNome}${docTexto} reside à ${p.enderecoCompleto}. ` +
    `O endereço acima citado é de abrangência da Unidade Básica de Saúde da ${p.ubsTexto} e o(a) morador(a) é usuário(a) do serviço aqui prestado, ` +
    `e acompanhado pelo Agente Comunitário de Saúde${acsFraseTexto}${microareaTexto}.`;

  const moradoresLinhas = p.moradoresPreenchidos.length === 0
    ? ['NÃO RESIDE MAIS NENHUM MORADOR']
    : p.moradoresPreenchidos.map(m => [m[0], m[1], m[2]].filter(Boolean).join(' — '));

  const visitasLinhas = p.visitas.length === 0
    ? ['NÃO EXISTEM REGISTROS DE VISITAS AO RESPONSÁVEL FAMILIAR NESTE ENDEREÇO']
    : p.visitas.map(v => [v[0], v[1]].filter(Boolean).join(' — '));

  const avisoSemMorador = p.moradoresPreenchidos.length === 0;
  const avisoSemVisita = p.visitas.length === 0;

  // Sem dado, o aviso fica sozinho em negrito num parágrafo (não é
  // lista); com dados, vira um <ul><li> de verdade (confirmado colando
  // certo, sem precisar de <br> entre os itens).
  const moradoresBloco = avisoSemMorador
    ? `<p><strong>${escapeHtml(moradoresLinhas[0])}</strong></p>`
    : `<ul>${moradoresLinhas.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
  const visitasBloco = avisoSemVisita
    ? `<p><strong>${escapeHtml(visitasLinhas[0])}</strong></p>`
    : `<ul>${visitasLinhas.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;

  // ESPACAMENTO = <br><br> (a técnica confirmada, garante linha em
  // branco de verdade). Só entra exatamente nos pontos marcados pelo
  // usuário: antes de cada título/frase, e 4x seguidos antes da linha de
  // assinatura. Em todo o resto — título -> conteúdo logo abaixo, linha
  // de assinatura -> nome do ACS — é só 1 <br>, sem linha em branco.
  const ESP1 = '<br>';
  const ESPACAMENTO = '<br><br>';

  const html = [
    `<p>${ESPACAMENTO}<strong>DECLARAÇÃO DE ENDEREÇO</strong>${ESP1}${escapeHtml(paragrafo)}${ESPACAMENTO}<strong>Também residem neste endereço, os seguintes moradores:</strong></p>`,
    moradoresBloco,
    `<p>${ESPACAMENTO}<strong>Últimas visitas realizadas à família:</strong></p>`,
    visitasBloco,
    `<p>${ESPACAMENTO}Para clareza e por ser verdade, firmo a presente declaração.${ESPACAMENTO}${ESPACAMENTO}${ESPACAMENTO}${ESPACAMENTO}________________________________${ESP1}${escapeHtml(acsTexto)}</p>`
  ].join('\n');

  // Texto simples: só o fallback de último caso, se o navegador não
  // conseguir colar HTML nenhum. Sem marcação nenhuma, só as quebras.
  const text = [
    'DECLARAÇÃO DE ENDEREÇO',
    paragrafo,
    '',
    'Também residem neste endereço, os seguintes moradores:',
    ...moradoresLinhas,
    '',
    'Últimas visitas realizadas à família:',
    ...visitasLinhas,
    '',
    'Para clareza e por ser verdade, firmo a presente declaração.',
    '',
    '',
    '________________________________',
    acsTexto
  ].join('\n');

  return { html, text };
}

// Copia HTML (com fallback para texto simples) selecionando um elemento
// oculto e usando execCommand('copy'). Funciona em mais contextos que a
// Clipboard API moderna (que em alguns popups de extensão é bloqueada por
// política do navegador mesmo com o clique do usuário).
function copyRichHtmlViaSelecao(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.setAttribute('contenteditable', 'true');
  document.body.appendChild(container);

  const range = document.createRange();
  range.selectNodeContents(container);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const ok = document.execCommand('copy');
  selection.removeAllRanges();
  document.body.removeChild(container);
  if (!ok) throw new Error('execCommand("copy") não foi aceito pelo navegador.');
}

async function copyRichHtml(html, text) {
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      return;
    } catch (err) {
      // Segue para o fallback abaixo (ex.: "Document is not focused" ou
      // permissão de clipboard bloqueada pela política do navegador).
      console.warn('Clipboard API falhou, tentando fallback via seleção:', err);
    }
  }
  try {
    copyRichHtmlViaSelecao(html);
  } catch (err) {
    console.warn('Fallback via seleção falhou, copiando só texto simples:', err);
    await navigator.clipboard.writeText(text);
  }
}

async function handleCopyOrientacoes() {
  if (!validarFormulario()) return;
  const data = collectFormData();
  try {
    const { html, text } = buildOrientacoesConteudo(data);
    await copyRichHtml(html, text);
    setStatus('Texto copiado — cole (Ctrl+V) na aba "Orientações" do prontuário no e-SUS.');
  } catch (err) {
    console.error(err);
    setStatus('Erro ao copiar: ' + err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadDefaults();
  loadLogo(); // começa a carregar o brasão em segundo plano, antes de precisar dele no PDF
  $('dataDeclaracao').value = new Date().toISOString().slice(0, 10);
  addVisitaRow();
  addVisitaRow();

  $('btnExtract').addEventListener('click', handleExtract);
  $('btnSaveDefaults').addEventListener('click', saveDefaults);
  $('btnAddMorador').addEventListener('click', () => addMoradorRow());
  $('btnAddVisita').addEventListener('click', () => addVisitaRow());
  $('primaryMemberSelect').addEventListener('change', applyPrimaryMember);
  $('declForm').addEventListener('submit', onSubmit);
  $('btnCopyOrientacoes').addEventListener('click', handleCopyOrientacoes);
});
