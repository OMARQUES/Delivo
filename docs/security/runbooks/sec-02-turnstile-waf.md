# SEC-02 Turnstile and WAF rollout

Objetivo: ativar anti-automação sem desligar os limites internos da aplicação.

## Turnstile

1. Criar dois widgets separados no Cloudflare Turnstile:
   - staging
   - production
2. Em cada widget, permitir apenas os hostnames do frontend correspondente.
3. No Worker API, registrar secrets por ambiente:

```bash
wrangler secret put RATE_LIMIT_HMAC_SECRET
wrangler secret put TURNSTILE_SECRET_KEY
```

4. Configurar `TURNSTILE_EXPECTED_HOSTNAMES` com os hostnames reais esperados.
5. Configurar `VITE_TURNSTILE_SITE_KEY` no build/deploy de `apps/web` e `apps/driver`.
6. Smoke-test obrigatório:
   - cadastro com token válido;
   - token expirado;
   - replay de token;
   - action incorreta;
   - login normal sem Turnstile;
   - login após falhas retornando `TURNSTILE_REQUIRED`;
   - segundo login enviando token.

## workers.dev e staging privado

Enquanto usar `workers.dev`, manter staging privado atrás de Cloudflare Access. Não assumir WAF de zona antes de domínio próprio/zone conectado.

## WAF depois de domínio/zone

Depois de anexar domínio próprio em uma Cloudflare zone, criar uma regra Free compatível:

- match: caminho `/auth/*`;
- janela: 20 requests por IP em 10 segundos;
- ação: challenge/throttle disponível no plano Free;
- escopo: staging e production com regras separadas.

## Rollback

Se houver falso positivo:

1. Desabilitar primeiro a regra WAF.
2. Manter rate limiting interno da aplicação.
3. Manter Turnstile obrigatório em cadastro/recuperação e adaptativo no login.
4. Só reduzir política interna com novo plano e teste.

Nunca commitar `TURNSTILE_SECRET_KEY` real, `RATE_LIMIT_HMAC_SECRET` real, ou sitekey de produção em arquivo de exemplo.
