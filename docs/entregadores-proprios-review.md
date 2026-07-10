# Revisão de implementação — Entregadores Próprios (④a)

Implementado em 2026-07-10 a partir do plano `docs/superpowers/plans/2026-07-10-entregadores-proprios.md`.

## Correções graves feitas durante a revisão

1. **Vazamento entre broadcasts:** somente `driverRequestedAt` não identifica o público. Um pedido enviado “aos meus entregadores” apareceria no pool freelance e poderia ser aceito pelo endpoint geral. Foi adicionado `orders.driverRequestTarget` (`GENERAL`/`OWN`), com filtros tanto nas listagens quanto nos aceites. A migration classifica solicitações antigas como `GENERAL`.
2. **Corrida na exclusividade do turno:** checar “turno ativo” e “turno do dia” apenas no service permitiria dois inserts concorrentes. Foram adicionados índices únicos para um turno ativo por entregador e um turno por entregador/loja/data operacional.
3. **Fechamento financeiro parcial:** fechar o turno e gravar os dois lados da diária em operações independentes poderia deixar turno fechado sem crédito/débito correspondente. O fechamento, crédito do driver e débito da loja agora ocorrem na mesma transação; `uniqueKey` mantém replay idempotente.
4. **Exclusividade incompleta:** o plano citava apenas pedidos avulsos. Pacotes do pool também são ocultados e recusados durante turno ativo.

## Decisões preservadas

- Snapshot de diária e extra no início do turno.
- Raio de 0,5 km; GPS ainda confiável-pendente.
- Diária cheia no encerramento, inclusive liberação antecipada.
- Loja fica com o frete; entregador próprio recebe somente extra por entrega concluída e diária.
- Fluxo freelance permanece inalterado para pedidos sem `shiftId`.

## Fora de escopo

Dispatch para entregador específico e fallback confirmado ficam no ④b; anti-fraude GPS fica no Plano 9; devolução/meia-taxa permanece como emenda separada. A data operacional usa `America/Sao_Paulo` até existir timezone configurável por loja.
