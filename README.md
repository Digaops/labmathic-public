# LabMathic

Plataforma pedagógica para organizar turmas, consultar materiais, elaborar questões e avaliações, acompanhar resultados e planejar a recomposição da aprendizagem.

Esta cópia de desenvolvimento usa React e Vite no cliente, Express e SQLite na API. O banco é criado na primeira execução. As migrações incluem o catálogo curricular e os lotes editoriais de Matemática. Os desafios novos permanecem em revisão no Banco de Questões. O catálogo escolar e os indicadores municipais incluem os respectivos arquivos de procedência em server/catalogs.

## Rodar na sua máquina

Use Node.js 22 LTS, npm e Git. Os comandos abaixo funcionam no PowerShell.

### 1. Instalar e criar as contas de demonstração

    git clone https://github.com/Digaops/labmathic-public.git
    cd labmathic-public
    npm --prefix server ci
    npm --prefix client ci
    node -e "const fs=require('node:fs');const crypto=require('node:crypto');fs.writeFileSync('server/.env','JWT_SECRET='+crypto.randomBytes(32).toString('hex')+'\n',{flag:'wx'})"
    npm --prefix server run seed

Se já houver um arquivo server/.env, mantenha-o e pule a geração. Na primeira carga, o terminal mostra os e-mails e as senhas geradas das contas de administração e professor. Guarde essas senhas localmente. Rodar o seed outra vez preserva as senhas existentes. Os registros de materiais de demonstração são exemplos para explorar a interface.

### 2. Abrir a aplicação

Em um terminal, na raiz do repositório:

    npm --prefix server start

Em outro terminal, na mesma pasta:

    npm --prefix client run dev -- --host 127.0.0.1

Abra [a aplicação local](http://127.0.0.1:5173). A API usa a porta 3001. A pasta client/src/pages contém as telas, client/src/components reúne os componentes compartilhados e client/src/index.css concentra os estilos globais.

## Verificar alterações

    npm run ci:verify

As contas, o banco, os uploads e as variáveis do ambiente ficam na própria máquina. A IA externa depende de configuração de servidor e de liberação no sistema. A cópia pública não leva as chaves ou os fluxos de publicação do ambiente original.
