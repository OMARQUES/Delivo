# Revisão de implementação — Devolução + Meia-taxa

Implementado em 2026-07-10 a partir de `docs/superpowers/plans/2026-07-10-devolucao-meia-taxa.md`.

## Falhas graves encontradas e corrigidas

1. **Estorno local sem gateway:** o helper marcava pagamentos como `REFUNDED` mesmo sem provider configurado. Agora a situação retorna 503 e preserva `APPROVED`; o estado local só muda após sucesso do gateway.
2. **Histórico de status falso:** todo estorno gerava evento `CANCELLED`, inclusive numa entrega falhada. O helper aceita o status e a descrição do contexto; falhas registram `DELIVERY_FAILED`.
3. **Falha sem caminho de retry:** status e evento precisam ser persistidos antes do efeito externo, mas um erro posterior no gateway tornava a rota de falha impossível de repetir. `failDelivery` reconhece a mesma falha pendente do próprio driver e reexecuta apenas o estorno idempotente.
4. **Extra fixo podia mudar durante a devolução:** o turno permite reajuste enquanto a devolução está pendente. O valor devido (frete freelance ou extra fixo) agora é congelado em `returnDriverPayCents` no instante da falha.
5. **Desvinculação individual quebraria pacotes:** um pedido com `batchId` não pode usar a ação individual de meia-taxa; a API retorna 409 e mantém a integridade do pacote até existir uma política específica para pacote.
6. **Chegada podia vazar para o próximo motorista:** a liberação voluntária não limpava `driverArrivedAt`. A chegada agora é removida junto da atribuição, impedindo meia-taxa baseada no deslocamento de outra pessoa.

## Comportamento final

- `DELIVERY_FAILED` marca devolução pendente, congela o pagamento devido e estorna pagamentos online.
- Nenhum crédito de driver é criado na falha.
- Loja ou suporte confirmam a devolução em transação com o ledger.
- Freelance recebe o frete; fixo recebe o extra congelado com débito correspondente da loja.
- Chegada é registrada antes da coleta, com GPS opcional auditado no evento.
- Desvinculação pós-chegada paga ao freelance metade do frete, arredondada; fixo não recebe meia-taxa.
- Desvincular limpa motorista, turno e chamado para novo direcionamento explícito.

## Fora de escopo

Validação forte de GPS/mock/root fica no Plano 9. Não há confirmação automática de devolução. Meia-taxa para pacotes exige uma decisão própria sobre valor e rateio.
