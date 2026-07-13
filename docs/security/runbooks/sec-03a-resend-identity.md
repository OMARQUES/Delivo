# Runbook SEC-03A — identidade por email e Resend

## Objetivo e estado

Operar cadastro por email, verificação, recuperação de senha, ativação de STORE e bootstrap de ADMIN sem expor senha, código, ticket, token ou credencial de provedor.

Este runbook não autoriza produção. Antes da promoção ainda são obrigatórios:

- gate local final da Stage 4, Task 9;
- staging privado em `workers.dev`, protegido por Cloudflare Access;
- smoke com um único destinatário permitido;
- domínio próprio e DNS de envio verificado no Resend para produção.

Google OAuth (SEC-03B), MFA (SEC-17), modernização do hash de senha e webhooks de bounce/complaint/suppression permanecem fora do SEC-03A.

## Regras de manuseio de segredos

- Criar valores diferentes por ambiente.
- `AUTH_CODE_SECRET`, `JWT_SECRET`, `RATE_LIMIT_HMAC_SECRET` e `TURNSTILE_SECRET_KEY` devem ser independentes. Nunca derivar um do outro.
- Gerar `AUTH_CODE_SECRET` com pelo menos 32 bytes aleatórios, usando password manager ou `openssl rand -base64 48` em terminal privado.
- Criar no Resend uma API key exclusiva por ambiente, com permissão somente de envio e restrita ao domínio quando disponível.
- Registrar secrets pelo prompt interativo de `wrangler secret put`; nunca passar valor como argumento CLI, commit, mensagem, ticket ou captura de tela.
- `EMAIL_ALLOWED_RECIPIENTS` contém PII. Em staging, armazená-lo como secret do Worker, não em arquivo rastreado.
- Nunca copiar código de seis dígitos, ticket de reset/setup, access token ou refresh token para logs ou documentação.

Task 9 deve criar o ambiente Wrangler nomeado `staging`. Remover `EMAIL_ALLOWED_RECIPIENTS` de `env.staging.vars` para não colidir/sobrescrever o secret homônimo. No diretório `apps/api`, registrar valores pelo prompt:

```bash
pnpm exec wrangler secret put AUTH_CODE_SECRET --env staging
pnpm exec wrangler secret put RESEND_API_KEY --env staging
pnpm exec wrangler secret put EMAIL_ALLOWED_RECIPIENTS --env staging
```

Antes de executar, confirmar que o comando aponta para o Worker de staging. Não usar o `wrangler.jsonc` atual com `APP_ENV=local` como configuração publicada. `wrangler secret list --env staging` pode conferir somente os nomes; não registrar valores no relatório.

## Configuração de staging em workers.dev

Config obrigatória:

- `APP_ENV=staging`;
- `EMAIL_FROM`: remetente de teste permitido pelo Resend;
- `PUBLIC_WEB_URL`: origem HTTPS exata do web em `workers.dev`;
- `EMAIL_ALLOWED_RECIPIENTS`: exatamente o email proprietário da conta Resend usado no smoke;
- `ALLOWED_ORIGINS`: somente web/driver de staging;
- `TURNSTILE_EXPECTED_HOSTNAMES`: hostnames reais de staging;
- secrets de identidade e Turnstile separados dos valores local/produção.

Enquanto não houver domínio verificado, o Resend permite o teste limitado ao proprietário da conta. A allowlist da aplicação deve repetir esse limite. Solicitações para outro destinatário mantêm contrato HTTP genérico, mas a entrega é bloqueada e auditada como `RECIPIENT_BLOCKED`.

Limites de `workers.dev`:

- não assumir WAF de zona/domínio;
- manter PostgreSQL rate limiting e Turnstile ativos;
- proteger todo staging com Cloudflare Access;
- não criar bypass amplo para `/auth/*` ou `/admin/*`;
- expor bypass machine-to-machine somente quando necessário e por path exato, com a proteção própria da integração.

## Requisitos adicionais de produção

Produção exige domínio próprio antes de aceitar destinatários arbitrários:

1. Configurar domínio customizado da aplicação/API.
2. Criar subdomínio dedicado de envio no Resend.
3. Publicar e validar SPF, DKIM e DMARC.
4. Usar `EMAIL_FROM` pertencente ao domínio verificado; `@resend.dev` é rejeitado pela config de produção.
5. Usar `PUBLIC_WEB_URL` HTTPS do domínio final.
6. Remover `EMAIL_ALLOWED_RECIPIENTS`; produção falha fechado se a allowlist estiver preenchida.
7. Criar nova API key sending-only e novos secrets exclusivos de produção.

Não promover usando remetente, URL ou secrets de staging.

## Bootstrap e ativação do primeiro ADMIN

Pré-condições: DB migrado, config de email validada e destinatário do ADMIN incluído na allowlist de staging.
Usar senha exclusiva de 15 a 128 caracteres, fora da lista de senhas comuns da aplicação.

Em terminal Bash privado, fornecer dados por prompt. Não usar argumentos CLI nem arquivo rastreado:

```bash
set +o history
read -rsp 'DATABASE_URL: ' DATABASE_URL && printf '\n'
read -rsp 'AUTH_CODE_SECRET: ' AUTH_CODE_SECRET && printf '\n'
read -rsp 'RESEND_API_KEY: ' RESEND_API_KEY && printf '\n'
read -rsp 'Senha inicial do ADMIN: ' ADMIN_PASSWORD && printf '\n'
read -rp 'Email do ADMIN: ' ADMIN_EMAIL
export DATABASE_URL AUTH_CODE_SECRET RESEND_API_KEY ADMIN_PASSWORD ADMIN_EMAIL
export APP_ENV=staging
export ADMIN_NAME='Admin'
export EMAIL_FROM='Delivery staging <onboarding@resend.dev>'
export PUBLIC_WEB_URL='https://WEB-STAGING.workers.dev'
export EMAIL_ALLOWED_RECIPIENTS="$ADMIN_EMAIL"
pnpm --filter @delivery/api db:seed
unset DATABASE_URL AUTH_CODE_SECRET RESEND_API_KEY ADMIN_PASSWORD ADMIN_EMAIL
unset APP_ENV ADMIN_NAME EMAIL_FROM PUBLIC_WEB_URL EMAIL_ALLOWED_RECIPIENTS
set -o history
```

Substituir URL/remetente pelos valores reais autorizados. A saída aceita contém somente `state` e `delivery`. Ela nunca deve mostrar email, senha, código ou ID de verificação.

Fluxo esperado:

1. Primeiro comando cria um único ADMIN `PENDING_EMAIL` e email de ativação.
2. ADMIN confirma o código recebido. Resultado esperado: `EMAIL_VERIFIED`, sem sessão.
3. ADMIN realiza login normal com email e senha.
4. Reexecução antes de 60 segundos falha com `RESEND_TOO_SOON`.
5. Reexecução posterior, ainda pendente, substitui o desafio e reenvia.
6. Reexecução após ativação retorna `ALREADY_ACTIVE`; nunca cria segundo ADMIN.

Se o envio falhar depois do commit, preservar o DB. Corrigir provedor/config e reexecutar após cooldown; não apagar ADMIN, challenge ou outbox manualmente.

## Ativação de STORE

1. ADMIN autenticado cria STORE informando owner por email, sem senha.
2. Owner fica `PENDING_EMAIL`; STORE fica `PENDING_ACTIVATION` e não aparece publicamente.
3. Owner confirma o código e recebe ticket efêmero de setup.
4. Cliente envia somente ticket + nova senha. Ticket não entra em URL, storage persistente ou relatório.
5. Ativação torna owner/STORE ativos atomicamente, sem emitir sessão.
6. Owner realiza login normal.

ADMIN nunca escolhe, recebe ou redefine a senha do owner. Loja pendente não pode operar endpoints `/store/*`.

## Smoke manual de staging

Executar somente com o destinatário allowlisted. Registrar resultados sem email bruto, código, ticket ou token.

### Cadastro e verificação

1. Cadastrar CUSTOMER novo por email; telefone deve ser opcional.
2. Confirmar resposta `202` contendo somente `verificationId`, `expiresAt`, `resendAt`.
3. Confirmar recebimento do email HTML/texto e código numérico de seis dígitos.
4. Confirmar código; CUSTOMER recebe sessão e email aparece verificado.
5. Confirmar que DRIVER exige telefone, fica `PENDING_APPROVAL` após verificar email e não recebe sessão antes da aprovação.

### Reenvio, código antigo e expiração

1. Criar novo fluxo e aguardar cooldown de 60 segundos.
2. Solicitar reenvio; confirmar que o ID público do fluxo permanece estável.
3. Código anterior deve falhar com erro genérico; novo código deve funcionar.
4. Em fluxo separado, aguardar dez minutos. Código expirado deve retornar `CODE_INVALID_OR_EXPIRED` sem detalhar causa.
5. Dentro das 24 horas do cadastro pendente, reenvio pode criar novo desafio; nunca estende o limite absoluto original.

### Recuperação e revogação de sessão

1. Manter sessão ativa do CUSTOMER em um cliente separado.
2. Iniciar recovery do email conhecido com Turnstile.
3. Comparar com email inexistente somente por status/chaves: ambos retornam `202` com `recoveryId` e `expiresAt`. Não medir/registrar PII.
4. Confirmar código e definir nova senha usando ticket efêmero.
5. Access token anterior deve falhar imediatamente.
6. Refresh token de qualquer família anterior deve falhar.
7. Senha antiga deve falhar; senha nova deve permitir login.
8. Confirmar recebimento da notificação de senha alterada.

### STORE e ADMIN

1. Executar bootstrap/ativação do ADMIN conforme seção anterior.
2. Provisionar uma STORE e validar invisibilidade pública enquanto pendente.
3. Confirmar código, configurar senha, efetuar login e validar publicação somente após ativação.
4. Confirmar que STORE_A não lista nem reenvia ativação de STORE_B.

## Inspeção segura do outbox

Usar preferencialmente o SQL Editor do Neon. Não colocar connection string em histórico/argumento CLI. Consultar somente metadados operacionais:

```sql
select
  template,
  status,
  attempt_count,
  failure_class,
  next_attempt_at,
  sent_at,
  provider_message_id,
  created_at
from email_outbox
order by created_at desc
limit 50;
```

Para challenges, não selecionar `email` nem `code_hash` durante operação manual:

```sql
select
  purpose,
  attempt_count,
  expires_at,
  consumed_at,
  invalidated_at,
  invalidation_reason,
  created_at
from auth_challenges
order by created_at desc
limit 50;
```

Estados esperados: `SENT`, `PENDING`/`PROCESSING` durante retry, `FAILED` para rejeição terminal e `CANCELLED` quando challenge deixa de ser utilizável. Nunca alterar status para forçar reenvio; usar endpoint/fluxo idempotente.

## Simulação de falha do Resend

Executar somente em staging e fora de outro teste:

1. Guardar key válida no password manager.
2. Substituir temporariamente `RESEND_API_KEY` por key revogada/inválida usando prompt do `wrangler secret put`.
3. Iniciar um fluxo com destinatário permitido.
4. Confirmar que criação transacional permanece válida e resposta pública continua destacada do envio.
5. Inspecionar outbox: rejeição de credencial deve terminar como `FAILED/PROVIDER_REJECTED`, sem corpo do provedor.
6. Restaurar key válida por prompt.
7. Após cooldown, solicitar reenvio/novo fluxo e confirmar `SENT` + `provider_message_id`.
8. Conferir `wrangler tail`: nenhum código, ticket, senha, token ou key pode aparecer.

Falhas reais `NETWORK`, `TIMEOUT`, `PROVIDER_RATE_LIMIT` ou `PROVIDER_UNAVAILABLE` são retryable; cron tenta novamente enquanto challenge estiver válido. Não é possível induzir com segurança um HTTP 5xx real do Resend em staging; essa classificação e retry permanecem cobertos pelos testes automatizados.

## Rollback e incidente

1. Bloquear na borda, por path exato, novos requests para cadastro, verification, recovery e password setup. Em `workers.dev`, usar Cloudflare Access deny; com domínio próprio, usar política equivalente de borda.
2. Manter login/sessões existentes somente se incidente não envolver credenciais. Se envolver, bloquear auth integralmente e rotacionar secrets.
3. Preservar DB, challenges e outbox para auditoria/recovery. Não truncar nem editar hashes/status manualmente.
4. Restaurar somente versão anterior conhecida como compatível com schema SEC-03A.
5. Nunca executar down migration de 0024/0025 e nunca reativar login/cadastro/convite por telefone.
6. Se `AUTH_CODE_SECRET` for rotacionado, considerar todos códigos/tickets ativos inválidos; comunicar reemissão segura após estabilização.
7. Reabrir paths gradualmente, repetir smoke allowlisted e registrar nova versão.

## Webhooks Resend adiados

Bounce, complaint e suppression ainda não chegam à aplicação. Até implementação:

- monitorar painel Resend manualmente;
- não insistir em destinatários com falha permanente;
- manter volume restrito;
- não interpretar `SENT` como entrega na caixa postal.

Antes de envio amplo, implementar webhook assinado/idempotente, suppression local, retenção mínima, auditoria sem conteúdo de email e runbook de remoção/reabilitação.

## Registro de evidência

Guardar somente:

```text
date_utc:
worker_commit:
worker_version:
recipient_class: RESEND_ACCOUNT_OWNER
resend_message_ids:
register: PASS|FAIL
resend_old_code: PASS|FAIL
expiry: PASS|FAIL
recovery_session_revocation: PASS|FAIL
store_activation: PASS|FAIL
resend_failure_simulation: PASS|FAIL
notes_without_pii_or_secrets:
```

Produção permanece bloqueada enquanto Task 9, smoke manual, domínio/DNS e remetente verificado não estiverem concluídos.
