import LegalNavigation, { legalSectionId } from '../components/LegalNavigation';
import { Link } from 'react-router-dom';
import { ArrowLeft, Database, Lock, Mail, ShieldCheck } from 'lucide-react';

const collectedData = [
  'nome, e-mail e perfil de acesso dos profissionais;',
  'município, escola, função institucional e vínculos profissionais autorizados;',
  'turmas, ano letivo, componentes curriculares e matrículas;',
  'nome de exibição e referência escolar opcional de estudantes, sem exigir conta, CPF, endereço ou telefone;',
  'avaliações, respostas, resultados, devolutivas e indicadores pedagógicos, quando esses módulos forem habilitados;',
  'planos de recomposição e de aula, incluindo observações inseridas pelo profissional responsável;',
  'senha armazenada de forma protegida por hash;',
  'favoritos, comentários e materiais acessados ou criados;',
  'registros administrativos e de auditoria;',
  'tokens temporários de recuperação de senha;',
  'links de compartilhamento, quando gerados;',
  'dados técnicos necessários à segurança, como IP, navegador e data de acesso.',
];

const purposes = [
  'autenticar usuários e permitir o acesso à plataforma;',
  'controlar permissões por município, escola, função profissional e turma;',
  'operar materiais, laboratórios, banco de questões e simulados;',
  'organizar turmas, aplicações, resultados e intervenções pedagógicas autorizadas;',
  'oferecer visões agregadas somente a gestores com vínculo institucional válido;',
  'prestar suporte e resolver problemas técnicos;',
  'manter registros de auditoria e segurança;',
  'melhorar a organização e a experiência de uso do serviço.',
];

const rights = [
  'confirmar se tratamos seus dados pessoais;',
  'solicitar acesso aos dados relacionados à sua conta;',
  'pedir correção de dados incompletos ou desatualizados;',
  'solicitar exclusão ou anonimização quando aplicável;',
  'solicitar revisão do vínculo institucional e das permissões atribuídas;',
  'pedir esclarecimentos sobre uso, retenção e segurança dos dados.',
];

export default function PrivacyPolicy() {
  return (
    <div className="legal-document relative min-h-screen overflow-hidden bg-[#061B3A] text-[#0F172A]">
      <div className="absolute inset-0 min-h-screen bg-[radial-gradient(circle_at_82%_8%,rgba(34,211,238,0.20),transparent_28%),radial-gradient(circle_at_8%_92%,rgba(37,99,235,0.18),transparent_32%),linear-gradient(135deg,#061B3A_0%,#071A36_48%,#0B254F_100%)]" />
      <div className="pointer-events-none absolute right-[-9rem] bottom-[-11rem] h-[36rem] w-[36rem] bg-[url('/logos/logo-labmathic-mark.png')] bg-contain bg-center bg-no-repeat opacity-[0.035] grayscale" />

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col px-3 py-3 sm:px-6 sm:py-5">
        <Link
          to="/login"
          className="mb-3 inline-flex min-h-11 w-fit items-center gap-2 rounded-full border border-white/20 bg-[rgba(255,255,255,0.09)] px-4 py-2 text-sm font-semibold text-[#EAF6FF] shadow-sm shadow-black/10 backdrop-blur transition-colors hover:border-cyan-200/40 hover:bg-[rgba(255,255,255,0.14)] hover:text-white"
        >
          <ArrowLeft size={16} />
          Voltar para o login
        </Link>

        <article className="rounded-2xl border border-white/80 bg-[#FFFFFF] p-4 text-[#0F172A] shadow-xl sm:p-7">
          <header id="documento-inicio" tabIndex={-1} className="mb-4 border-b border-slate-200 pb-4">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl border border-blue-100 bg-[#EFF6FF] text-[#2563EB]">
              <ShieldCheck size={30} />
            </div>
            <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[#2563EB]">
              Documento preliminar
            </p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-[#0F172A] sm:text-3xl">
              Política de Privacidade
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#64748B]">
              Este texto é um rascunho operacional para revisão jurídica posterior. Ele descreve, de forma clara,
              as categorias de dados que o LabMathic pode tratar conforme os módulos efetivamente habilitados e
              utilizados pela instituição responsável.
            </p>
          </header>

          <LegalNavigation titles={["1. Quem somos","2. Dados que coletamos","3. Para que usamos os dados","4. Quem pode acessar","5. Compartilhamento","6. Retenção","7. Direitos do usuário","8. Segurança","9. Crianças e adolescentes","10. Responsabilidades institucionais","11. Canal de contato","12. Revisões futuras"]} />
          <div className="space-y-7">
            <Section title="1. Quem somos">
              <p>
                O LabMathic é uma plataforma educacional voltada à organização e ao acesso a materiais,
                laboratórios educacionais, banco de questões, turmas, avaliações e planejamento pedagógico. O
                sistema é usado por administradores, gestores, coordenadores e professores autorizados. Estudantes
                podem acessar aplicações específicas sem receber uma conta profissional na plataforma.
              </p>
            </Section>

            <Section title="2. Dados que coletamos">
              <p>No estágio atual, podemos tratar os seguintes dados:</p>
              <BulletList items={collectedData} />
              <Notice>
                A existência técnica de um módulo não autoriza, por si só, a inserção de dados reais. Recursos
                institucionais, turmas e avaliações permanecem sujeitos à habilitação controlada, à finalidade
                educacional definida pela instituição e às regras aplicáveis de transparência, acesso e retenção.
              </Notice>
            </Section>

            <Section title="3. Para que usamos os dados">
              <p>Os dados são usados para finalidades operacionais da plataforma:</p>
              <BulletList items={purposes} />
            </Section>

            <Section title="4. Quem pode acessar">
              <p>
                O acesso segue o menor escopo necessário: professores visualizam somente as escolas e turmas às
                quais estão vinculados; gestores e coordenadores escolares ficam restritos à própria escola; gestores
                municipais podem receber visão agregada apenas do município autorizado; e o administrador geral atua
                na governança técnica do serviço. Turmas ainda não verificadas institucionalmente não entram em visões
                agregadas. A equipe técnica pode acessar dados somente quando necessário para suporte, segurança ou
                auditoria, com finalidade e rastreabilidade.
              </p>
            </Section>

            <Section title="5. Compartilhamento">
              <p>
                O LabMathic não vende dados pessoais. Dados podem ser compartilhados apenas quando necessário
                para operação do serviço, suporte técnico, cumprimento de obrigação legal ou regulatória, proteção da
                plataforma ou atendimento de solicitação institucional autorizada. Compartilhamentos e exportações
                devem respeitar o município, a escola, a finalidade declarada e os direitos dos titulares.
              </p>
            </Section>

            <Section title="6. Retenção">
              <p>
                Dados de conta podem ser mantidos enquanto o vínculo estiver ativo. Turmas, matrículas, avaliações,
                resultados e planejamentos devem seguir prazos definidos com a instituição, considerando calendário
                escolar, finalidade pedagógica, obrigações aplicáveis e exercício de direitos. Logs e auditorias podem
                ser preservados pelo período necessário à segurança e à rastreabilidade. Tokens e credenciais
                temporárias expiram e não são armazenados em texto aberto quando o desenho técnico permite.
              </p>
            </Section>

            <Section title="7. Direitos do usuário">
              <p>Usuários podem solicitar:</p>
              <BulletList items={rights} />
              <p>
                Solicitações relacionadas a estudantes podem exigir validação do responsável e encaminhamento pela
                escola ou secretaria competente. Algumas medidas dependem de confirmação de identidade, preservação
                de obrigações legítimas e análise da trilha de auditoria antes da execução.
              </p>
            </Section>

            <Section title="8. Segurança">
              <p>
                O sistema adota medidas técnicas e administrativas como autenticação, senha protegida por hash,
                isolamento entre municípios, vínculo explícito entre profissional, escola e turma, chaves de
                integridade no banco, identificadores públicos opacos, auditoria e liberação gradual por feature flag
                com kill switch. Essas medidas reduzem riscos, mas devem ser continuamente revisadas.
              </p>
            </Section>

            <Section title="9. Crianças e adolescentes">
              <p>
                Dados de estudantes devem ser tratados com minimização, finalidade educacional clara e prevalência
                do melhor interesse da criança e do adolescente. O módulo não exige CPF, endereço, telefone, e-mail,
                data de nascimento ou senha do estudante. Profissionais não devem inserir esses dados, nem informações
                sensíveis desnecessárias, em nomes, observações ou campos livres.
              </p>
            </Section>

            <Section title="10. Responsabilidades institucionais">
              <p>
                A definição de controlador, operador, encarregado, bases legais, comunicações aos titulares e prazos
                de retenção depende do contexto de cada contratação e rede de ensino. A tecnologia não substitui essa
                definição. A habilitação com dados reais deve ocorrer somente após a instituição formalizar suas
                responsabilidades e procedimentos.
              </p>
            </Section>

            <Section title="11. Canal de contato">
              <p>
                Para solicitações sobre privacidade, use o canal institucional definido pelo responsável pelo sistema.
                Enquanto não houver um endereço definitivo, utilize o contato provisório:
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-blue-100 bg-[#EFF6FF] px-4 py-3 text-[#1D4ED8]">
                <Mail size={20} />
                <span className="font-bold">diretoriaconectae@gmail.com</span>
              </div>
            </Section>

            <Section title="12. Revisões futuras">
              <p>
                Esta política deve ser revisada quando houver mudança relevante de finalidade, categoria de dados,
                integração, compartilhamento, perfil de acesso ou regra institucional. Alterações materiais devem ser
                comunicadas pelos canais adequados antes de produzirem efeitos para os titulares envolvidos.
              </p>
            </Section>
          </div>

          <FooterNote icon={Database}>
            Última revisão operacional: agosto de 2026. Documento sujeito à revisão jurídica e institucional.
          </FooterNote>
        </article>
        <a href="#documento-inicio" className="mt-3 inline-flex min-h-11 w-fit items-center rounded-xl px-3 font-semibold text-white underline underline-offset-4">Voltar ao início do documento</a>
      </main>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h2 id={legalSectionId(title)} tabIndex={-1} className="scroll-mt-4 text-xl font-extrabold text-[#0F172A]">{title}</h2>
      <div className="space-y-3 text-base leading-7 text-[#475569]">{children}</div>
    </section>
  );
}

function BulletList({ items }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span className="mt-3 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#2563EB]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Notice({ children }) {
  return (
    <div className="rounded-2xl border border-cyan-100 bg-[#ECFEFF] px-4 py-3 text-sm font-semibold leading-6 text-cyan-900">
      {children}
    </div>
  );
}

function FooterNote({ icon: Icon, children }) {
  return (
    <footer className="mt-10 flex items-start gap-3 rounded-2xl border border-slate-200 bg-[#F8FAFC] px-4 py-4 text-sm leading-6 text-[#64748B]">
      <Icon className="mt-0.5 flex-shrink-0 text-[#2563EB]" size={19} />
      <p>{children}</p>
    </footer>
  );
}
