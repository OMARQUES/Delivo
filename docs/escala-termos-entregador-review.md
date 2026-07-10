# Revisão de implementação — termos e reajuste de turno (④a-2)

Implementado em 2026-07-10 a partir de `docs/superpowers/plans/2026-07-10-escala-termos-entregador.md`.

## Falhas graves encontradas e corrigidas

1. **Retroativo calculado pelo valor anterior do turno:** usar apenas `novo − antigo` em todos os pedidos falha quando houve um reajuste não retroativo. Pedidos do mesmo turno podem ter sido pagos com valores diferentes. A implementação soma os lançamentos `DRIVER_PER_DELIVERY_CREDIT` de cada pedido e cria somente o delta necessário para que cada entrega chegue ao novo valor.
2. **Corrida entre entrega e reajuste:** o status `DELIVERED` era confirmado antes do ledger. Um reajuste concorrente poderia encontrar a entrega sem o crédito-base e lançar um retroativo integral; depois a conclusão lançaria o crédito-base novamente. Conclusão, evento e ledger agora são atômicos, e conclusão/reajuste usam a mesma ordem de lock (`turno → pedido`).
3. **Proposta perdida durante confirmação:** selecionar os termos pendentes e atualizar apenas por `id` permitiria que uma nova proposta fosse sobrescrita ou apagada por uma confirmação concorrente. Propor, aceitar e recusar agora bloqueiam o vínculo e validam `CONFIRMED` dentro de transações.
4. **Estado pending parcial:** quatro colunas nullable poderiam ficar inconsistentes por escrita externa ou migration futura. Uma constraint exige que todas estejam preenchidas ou todas nulas.

## Comportamento final

- Alterar vínculo cria proposta completa; termos ativos só mudam após aceite do entregador.
- Recusa limpa a proposta sem alterar os termos ativos.
- Reajuste do turno afeta entregas futuras e a diária de encerramento.
- Retroativo opcional reconcilia cada pedido entregue pelo saldo real do ledger, inclusive reduções.
- Repetir o mesmo reajuste retroativo não cria valor financeiro duplicado.
- Tenant e RBAC são verificados nas rotas e nos services.

## Fora de escopo

Valores e horários distintos por dia continuam futuros. O modelo atual mantém um valor de diária/extra por vínculo e uma agenda semanal de referência.
