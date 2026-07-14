# Runbook — private workers.dev staging

## Resources

- Workers:
  - `delivery-api-staging`
  - `delivery-web-staging`
  - `delivery-driver-staging`
- URLs:
  - `https://delivery-api-staging.otavio-marques20.workers.dev`
  - `https://delivery-web-staging.otavio-marques20.workers.dev`
  - `https://delivery-driver-staging.otavio-marques20.workers.dev`
- R2: `delivo-media-staging`, binding `BUCKET`.
- Hyperdrive: `delivery-db-staging`, binding `HYPERDRIVE`.
- PostgreSQL runtime role: `delivo_app_staging`.
- Turnstile widget: `delivery-staging`, modo Managed.
- Cloudflare Access application: `delivery-staging`.

Nenhum identificador pessoal, segredo ou credencial pertence a este documento.

## Access and CORS settings

- Uma aplicação self-hosted protege os três hostnames concretos.
- A sessão do Access dura 24 horas e usa email one-time PIN.
- A política Allow contém somente as duas identidades piloto individuais mantidas fora do Git.
- Não há `Everyone`, domínio de email, wildcard, Bypass ou Service Auth.
- `OPTIONS` segue ao origin para o preflight; as demais requisições exigem Access.
- Web e driver enviam o cookie Access com `credentials: include`.
- A API autoriza somente as origens exatas de web e driver, com credenciais.
- Origem desconhecida não recebe `Access-Control-Allow-Origin`.

## Non-secret deployment commands

```bash
pnpm --filter @delivery/web build:staging
pnpm --filter @delivery/driver build:staging
pnpm --dir apps/api exec wrangler deploy --env staging --dry-run
pnpm --dir apps/web exec wrangler deploy --env staging --dry-run
pnpm --dir apps/driver exec wrangler deploy --env staging --dry-run
pnpm --dir apps/api exec wrangler deploy --env staging
pnpm --filter @delivery/web deploy:staging
pnpm --filter @delivery/driver deploy:staging
pnpm --dir apps/api exec wrangler secret list --env staging
```

Wrangler 4 usa R2 local por padrão. Toda inspeção ou mutação do bucket de staging deve declarar `--remote`. A rota pública aceita somente chaves `logos/` ou `products/`; o smoke usa payload aleatório temporário em uma chave válida e o remove imediatamente:

```bash
SMOKE_FILE=$(mktemp)
SMOKE_KEY="logos/$(openssl rand -hex 16).png"
openssl rand -hex 32 > "$SMOKE_FILE"
pnpm --dir apps/api exec wrangler r2 object put \
  "delivo-media-staging/$SMOKE_KEY" --file "$SMOKE_FILE" --remote
# Validar status e hash pelo Worker, sem registrar o corpo.
pnpm --dir apps/api exec wrangler r2 object delete \
  "delivo-media-staging/$SMOKE_KEY" --remote
rm -f "$SMOKE_FILE"
unset SMOKE_FILE SMOKE_KEY
```

## Secret-name checklist

O Worker API de staging contém exatamente estes secrets; conferir apenas nomes:

- `JWT_SECRET`
- `RATE_LIMIT_HMAC_SECRET`
- `AUTH_CODE_SECRET`
- `RESEND_API_KEY`
- `TURNSTILE_SECRET_KEY`
- `EMAIL_ALLOWED_RECIPIENTS`

Valores entram somente pelos prompts ocultos do dashboard ou `wrangler secret put`. Não copiar valor, destinatário ou saída de provedor para Git, terminal compartilhado ou evidência.

## CUSTOMER/recovery smoke evidence

O smoke privado confirmou cadastro CUSTOMER, email, confirmação, login, substituição de challenge, recuperação de senha, revogação imediata das sessões anteriores e login somente com a senha nova. Replay de Turnstile falhou fechado. Destinatário fora da allowlist manteve resposta pública genérica, não recebeu email e terminou como `RECIPIENT_BLOCKED`.

As consultas operacionais selecionaram somente metadados. Outbox confirmou envios permitidos, cancelamento do challenge substituído e bloqueio terminal do destinatário não permitido. Challenges confirmaram consumo dos fluxos usados e invalidação `REPLACED` do fluxo anterior.

```text
date_utc: 2026-07-14
source_commit: 9ab5d7d
worker_versions: api=9a829247-455f-4cbc-9ca2-cd59f0941ceb; web=1428b94d-5a09-49bf-aba4-dea9bb723110; driver=c1c56368-810e-4098-942b-918b6b94145b
access_allowed: PASS
access_denied: PASS
cors_allowed: PASS
cors_denied: PASS
customer_verification: PASS
recovery_session_revocation: PASS
turnstile_replay: PASS
recipient_allowlist: PASS
hyperdrive_runtime_role: PASS
r2_binding: PASS
logs_sanitized: PASS
notes_without_pii_or_secrets: CUSTOMER/recovery private smoke passed; STORE and production remain blocked.
```

## R2/Hyperdrive evidence

- O Worker recuperou pelo binding `BUCKET` o mesmo payload aleatório enviado ao bucket remoto; status e SHA-256 coincidiram.
- O objeto remoto e o arquivo temporário foram removidos após a comparação.
- Hyperdrive usa `delivery-db-staging`, runtime role `delivo_app_staging`, TLS `require`, limite cinco e cache desabilitado.
- A verificação SQL do runtime role confirmou DML necessário sem ownership, DDL, administração ou herança de `neon_superuser`.

## Rollback

1. Manter Cloudflare Access ativo durante todo rollback.
2. Bloquear novos fluxos de identidade pela política deny do Access se houver incidente.
3. Restaurar uma versão Worker anterior conhecida; não executar down migration.
4. Preservar DB, challenges e outbox para auditoria.
5. Rotacionar somente secrets afetados; rotação de `AUTH_CODE_SECRET` invalida challenges e tickets ativos.
6. Remover qualquer objeto R2 temporário e repetir o smoke allowlisted antes de reabrir.

## Known limitations and production blockers

- Staging continua privado; esta evidência não autoriza beta público nem produção.
- STORE activation aguarda domínio de envio verificado.
- Domínio/DNS, envio para múltiplos destinatários e remetente de produção continuam pendentes.
- Mercado Pago webhook bypass/signature smoke, Firebase e Google OAuth estão fora deste rollout.
- Bounce, complaint, suppression e webhook Resend continuam adiados.
- `/docs`, `/openapi.json` e `/health/db` permanecem 404 fora de local.
- A validação ADMIN exige reset destrutivo separado e confirmação explícita.
