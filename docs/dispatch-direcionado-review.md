# Revisão de implementação — Dispatch Direcionado (④b)

Implementado em 2026-07-10 a partir de `docs/superpowers/plans/2026-07-10-dispatch-direcionado.md`.

## Falhas graves encontradas e corrigidas

1. **Transições prometidas eram bloqueadas pelo código existente:** `requestDriver` só escalava `OWN → GENERAL`, e `requestDriverOwn` rejeitava origem `SPECIFIC`. O fluxo agora permite `SPECIFIC ↔ OWN` e `SPECIFIC|OWN → GENERAL`, mantendo GENERAL irreversível.
2. **Aceite podia sobreviver ao encerramento concorrente do turno:** o aceite próprio lia o turno e atualizava o pedido sem lock. Aceites de pedido e pacote agora bloqueiam o turno antes do claim, usando a mesma disciplina das operações de fechamento/reajuste.
3. **`shiftId` residual ao liberar pacote:** liberar um pacote próprio limpava apenas `driverId`; uma nova atribuição poderia carregar contexto financeiro antigo. A liberação e o cancelamento agora limpam `shiftId` e todos os campos de direcionamento aplicáveis.
4. **Push geral violava exclusividade:** entregadores em turno eram excluídos da lista/aceite geral, mas ainda recebiam FCM do pool. A seleção de tokens GENERAL agora exclui qualquer turno ativo; OWN e SPECIFIC usam somente turnos da loja.
5. **Corrida início de turno × aceite geral:** as duas operações podiam passar nas verificações simultaneamente e deixar o motorista com turno ativo e uma nova entrega GENERAL. Ambas agora serializam pela linha do usuário do entregador antes de consultar/criar o turno ou efetuar o claim.

## Invariantes finais

- Pedido e pacote aceitam `GENERAL`, `OWN` ou `SPECIFIC`.
- SPECIFIC só alcança entregador em turno ativo na loja e só o alvo aceita ou recusa.
- Recusa apenas sinaliza a loja; não existe fallback automático.
- GENERAL não regride para alvos próprios.
- Claims e redirecionamentos são serializados no banco e validam o alvo no `UPDATE`.
- Pacote próprio atribui o mesmo `shiftId` a todos os pedidos; o ledger existente aplica diária/extra sem mudanças no serviço financeiro.
- Pacote geral freelance continua recebendo o frete normal.

## Fora de escopo

Ofertas ou contrapropostas de preço ficam para o ④c. Falha com devolução e eventual meia-taxa permanece em fluxo separado.
