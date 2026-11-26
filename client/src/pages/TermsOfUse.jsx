import LegalNavigation, { legalSectionId } from '../components/LegalNavigation';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, Mail, ShieldCheck } from 'lucide-react';

const accountRules = [
  'usar uma senha segura e manter seus dados de acesso em sigilo;',
  'não compartilhar usuário, senha ou links restritos com pessoas não autorizadas;',
  'avisar o responsável pelo sistema caso suspeite de acesso indevido;',
  'manter nome e e-mail atualizados quando solicitado pela instituição.',
];

const allowedUse = [
  'consultar materiais pedagógicos disponíveis;',
  'acessar laboratórios educacionais autorizados;',
  'usar banco de questões e simulados conforme o perfil de acesso;',
  'organizar escolas, turmas, avaliações, resultados e planejamentos quando o módulo estiver habilitado;',
  'favoritar, comentar e organizar conteúdos de forma adequada;',
  'realizar ações administrativas somente quando autorizado.',
];

const conductRules = [
  'publicar comentários respeitosos e relacionados ao uso pedagógico;',
  'inserir somente os dados de estudantes estritamente necessários, nos campos destinados a essa finalidade e com autorização institucional;',
  'não inserir CPF, endereço, telefone, e-mail pessoal, senha ou informação sensível desnecessária em nomes e observações;',
  'não enviar arquivos com vírus, códigos maliciosos ou conteúdo inadequado;',
  'não tentar acessar áreas, dados ou recursos fora do próprio perfil de permissão.',
];

export default function TermsOfUse() {
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
              <BookOpen size={30} />
            </div>
            <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-[#2563EB]">
              Documento preliminar
            </p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-[#0F172A] sm:text-3xl">
              Termos de Uso
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#64748B]">
              Estes termos são um rascunho operacional para revisão jurídica posterior. O objetivo é orientar o uso
              adequado do LabMathic por administradores, gestores, coordenadores e professores autorizados.
            </p>
          </header>

          <LegalNavigation titles={["1. Uso permitido da plataforma","2. Responsabilidade pela conta","3. Perfis de acesso","4. Dados de estudantes e responsabilidade pedagógica","5. Materiais e direitos autorais","6. Comentários e conduta","7. Compartilhamento","8. Disponibilidade do serviço","9. Segurança e uso indevido","10. Alterações nos termos","11. Canal de contato"]} />
          <div className="space-y-7">
            <Section title="1. Uso permitido da plataforma">
              <p>O LabMathic deve ser usado para finalidades educacionais e administrativas relacionadas ao acervo:</p>
              <BulletList items={allowedUse} />
            </Section>

            <Section title="2. Responsabilidade pela conta">
              <p>Cada usuário é responsável pelo uso da própria conta. É importante:</p>
              <BulletList items={accountRules} />
            </Section>

            <Section title="3. Perfis de acesso">
              <p>
                O sistema diferencia o administrador geral, gestores municipais, gestores ou coordenadores escolares
                e professores. Um professor pode atuar em mais de uma escola. Cada vínculo possui escopo próprio, e o
                usuário deve acessar apenas o município, a escola, a turma e os dados compatíveis com sua função.
                Visões agregadas são exclusivas de gestores autorizados e não incluem turmas com vínculo institucional
                ainda pendente de verificação.
              </p>
            </Section>

            <Section title="4. Dados de estudantes e responsabilidade pedagógica">
              <p>
                Quando os módulos de turmas e avaliações estiverem habilitados, a instituição e os profissionais
                autorizados deverão cadastrar apenas dados necessários à finalidade educacional informada. Resultados,
                agrupamentos e planos de recomposição são apoios pedagógicos: não devem ser usados para rotular,
                constranger, discriminar ou tomar decisões automatizadas sem análise profissional e contexto.
              </p>
            </Section>

            <Section title="5. Materiais e direitos autorais">
              <p>
                Os materiais disponíveis na plataforma devem ser usados de forma adequada ao contexto educacional. O
                usuário deve respeitar direitos autorais, licenças, créditos e restrições de uso dos conteúdos enviados
                ou acessados no sistema.
              </p>
            </Section>

            <Section title="6. Comentários e conduta">
              <p>Ao comentar, enviar arquivos ou usar recursos colaborativos, o usuário deve:</p>
              <BulletList items={conductRules} />
            </Section>

            <Section title="7. Compartilhamento">
              <p>
                Links de compartilhamento, quando disponíveis, devem ser usados apenas para a finalidade educacional
                autorizada. O usuário não deve divulgar links restritos de forma pública ou fora do contexto permitido
                pela instituição.
              </p>
            </Section>

            <Section title="8. Disponibilidade do serviço">
              <p>
                O LabMathic pode passar por manutenções, atualizações ou interrupções temporárias. A equipe
                responsável deve buscar estabilidade e continuidade, mas este documento não garante disponibilidade
                ininterrupta do serviço.
              </p>
            </Section>

            <Section title="9. Segurança e uso indevido">
              <p>
                A plataforma pode registrar acessos e ações administrativas para segurança, suporte e auditoria. Uso
                indevido, tentativa de acesso não autorizado ou envio de conteúdo inadequado pode resultar em revisão
                da conta, bloqueio de acesso ou outras medidas administrativas.
              </p>
            </Section>

            <Section title="10. Alterações nos termos">
              <p>
                Estes termos podem ser atualizados conforme o sistema evoluir, especialmente diante de novos módulos,
                integrações institucionais, categorias de dados ou regras aplicáveis. Alterações materiais devem ser
                comunicadas pelos canais adequados.
              </p>
            </Section>

            <Section title="11. Canal de contato">
              <p>
                Dúvidas sobre estes termos devem ser encaminhadas ao responsável institucional pelo sistema. Enquanto
                não houver canal definitivo, use o contato provisório:
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-blue-100 bg-[#EFF6FF] px-4 py-3 text-[#1D4ED8]">
                <Mail size={20} />
                <span className="font-bold">diretoriaconectae@gmail.com</span>
              </div>
            </Section>
          </div>

          <FooterNote>
            O LabMathic pode tratar dados de escolas, turmas, estudantes, avaliações e desempenho quando os módulos
            correspondentes forem habilitados. Esse uso depende de autorização institucional, finalidade educacional,
            acesso restrito, transparência e regras de privacidade e retenção aplicáveis.
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

function FooterNote({ children }) {
  return (
    <footer className="mt-10 flex items-start gap-3 rounded-2xl border border-slate-200 bg-[#F8FAFC] px-4 py-4 text-sm leading-6 text-[#64748B]">
      <ShieldCheck className="mt-0.5 flex-shrink-0 text-[#2563EB]" size={19} />
      <p>{children}</p>
    </footer>
  );
}
