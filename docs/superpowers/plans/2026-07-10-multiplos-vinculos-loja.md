# Múltiplos vínculos, ocorrências de turno e exceções — plano revisado

**Objetivo:** permitir vários vínculos não sobrepostos do mesmo entregador, inclusive na mesma loja, iniciar cada turno pela ocorrência de um vínculo e tratar atraso/reajuste com consentimento e histórico auditável.

## Decisões finais

1. `store_drivers` deixa de ser único por `(store, driver)`. Cada vínculo tem agenda e termos próprios.
2. Apenas vínculos `CONFIRMED`, não expirados, reservam agenda. `INVITED`, `REMOVED` e expirados não conflitam.
3. `schedule: []` significa vínculo confirmado sem agenda: aparece nas listas, não reserva horário e não pode iniciar turno.
4. Uma agenda é vazia, semanal ou por datas; não mistura modalidades, não repete ocorrência e não contém sobreposição interna. Para dois períodos no mesmo dia, usar dois vínculos.
5. Toda ativação/mudança de agenda é serializada por `users.id FOR UPDATE` e usa o mesmo helper de conflito.
6. Turno inicia por `storeDriverId`, grava FK e congela `scheduledStartAt`, `scheduledEndAt`, diária e extra.
7. Janela normal de início: 30 minutos antes até 30 minutos depois do início combinado, sempre antes do fim. API aplica a regra; UI apenas antecipa o estado.
8. Depois da tolerância, só uma autorização excepcional aceita pelo entregador libera o início. O fim original permanece, salvo novo fim explícito da loja. Valores excepcionais são opcionais e congelados no turno.
9. Um turno ativo global por entregador; um turno por vínculo/ocorrência (`store_driver_id`, `work_date`). Dois vínculos disjuntos no mesmo dia geram dois turnos e duas diárias.
10. Remoção e confirmação de mudança de agenda ficam bloqueadas durante turno ativo daquele vínculo. Propostas podem ser criadas. Mudanças apenas financeiras do vínculo continuam valendo para turnos futuros.
11. Reajuste de turno ativo vira proposta: qualquer alteração exige confirmação do entregador. O extra pode valer só para próximas entregas ou retroativamente; diária nova vale para o turno inteiro. Ledger continua imutável, usando ajustes.
12. Vínculo DATES expira no fim real da última janela, inclusive overnight. Turno já iniciado continua válido e alcançável pelo dispatch.
13. Fuso do MVP: `America/Sao_Paulo`.

## Invariantes de concorrência e locks

- Ordem para ativar agenda: lock do usuário → lock do recurso (vínculo/oferta) → reler agendas → gravar.
- Aceite de oferta mantém claim atômico de vaga, mas também segue o lock do usuário antes de validar conflito.
- Confirmação simultânea de dois convites/termos sobrepostos produz exatamente um sucesso.
- Início: lock do usuário → vínculo/autorização → checar pool geral/turno ativo/janela → inserir turno → marcar autorização `USED`.
- Aceite de reajuste: lock do turno → proposta → pedidos entregues; mesma ordem de `completeDelivery`.

## Schema e migration

### `store_drivers`

- remover `store_drivers_unique`;
- adicionar índices `(driver_user_id, status)` e `(store_id, status)`;
- manter registros removidos como histórico.

### `driver_shifts`

- `store_driver_id uuid NOT NULL` FK restrict;
- `scheduled_start_at timestamptz` (nullable apenas para histórico migrado);
- manter `scheduled_end_at`;
- trocar unique `(driver_user_id, store_id, work_date)` por `(store_driver_id, work_date)`;
- manter unique parcial de um turno `ACTIVE` por entregador.

Migration segura: adicionar FK nullable, fazer backfill enquanto o unique antigo ainda existe, validar ausência de nulos, aplicar `NOT NULL`, criar índices novos e só então remover índices antigos. Ensaiar em banco populado/backup; migration fresca não testa o backfill.

### `shift_start_authorizations`

- vínculo, ocorrência (`work_date`), status `PENDING|ACCEPTED|REJECTED|CANCELLED|USED`;
- `authorized_until`, `scheduled_end_at`, diária, extra, observação e timestamps de decisão;
- unique parcial: no máximo uma autorização `PENDING|ACCEPTED` por vínculo/ocorrência;
- novo fim deve ser posterior ao limite de início e produzir duração total de no máximo 24h;
- extensão é validada contra toda agenda ativa, inclusive outras ocorrências do mesmo vínculo.

### `shift_term_proposals`

- turno, status `PENDING|ACCEPTED|REJECTED|CANCELLED`;
- diária, extra, `apply_retroactive`, observação, criação/decisão;
- no máximo uma proposta pendente por turno.

## Serviços

### Shared/agendas

- `schedulesConflict(a,b)` reutiliza a engine civil/overnight existente;
- validar agenda homogênea, chaves únicas e ausência de conflito interno;
- helpers de ocorrência convertem weekly/date em intervalo absoluto SP;
- expiração DATES usa o maior `scheduledEndAt`, não meia-noite.

### Vínculos

- `driverActiveSchedule` e `assertNoScheduleConflict` são a única regra de conflito;
- convite sempre insere novo `INVITED`;
- confirmação de convite e de agenda pendente relê tudo sob lock do usuário;
- remoção/alteração de agenda recusa se houver turno ativo no vínculo;
- listas continuam filtrando expirados, sem esconder vínculo vazio confirmado.

### Ofertas

- aceite sempre insere novo vínculo;
- usa `assertNoScheduleConflict` na mesma transação;
- mantém locks de vaga e usuário, resposta única e fechamento ao lotar;
- expiração considera o fim real da última janela.

### Turnos

- `startShift(db, driverUserId, storeDriverId, gps)`;
- vínculo vazio: 409 com mensagem específica;
- resolve ocorrência de hoje ou de ontem quando a tolerância cruza meia-noite;
- normal: permite `[start-30min, start+30min]` e antes do fim;
- excepcional: exige autorização `ACCEPTED`, dentro de `authorizedUntil` e antes do fim autorizado;
- snapshot de janela/valores no insert;
- erros de unique mapeados por constraint, sem catch-all ambíguo.

### Autorização excepcional

- loja cria/cancela para vínculo próprio e ocorrência existente;
- somente após existir uma ocorrência agendada; não transforma vínculo vazio em avulso;
- driver dono aceita/rejeita;
- valores omitidos preservam os do vínculo;
- início consome autorização atomicamente (`USED`).

### Reajuste ativo

- loja propõe/cancela; não altera turno imediatamente;
- driver aceita/rejeita;
- aceite atualiza snapshot financeiro;
- `applyRetroactive=false`: novas entregas usam novo extra;
- `true`: cria ajustes para entregas `DELIVERED`; diária final usa novo valor integral;
- turno encerrado não aceita nem cria proposta.

### Dispatch

- todos os JOINs `driver_shifts → store_drivers` usam `store_driver_id`;
- turno já iniciado continua alcançável mesmo se o vínculo expirar durante overnight;
- remoção durante ativo é bloqueada.

## API

- `POST /driver/shifts` recebe `storeDriverId`.
- `POST /store/me/shift-authorizations`
- `POST /store/me/shift-authorizations/{id}/cancel`
- `POST /driver/shift-authorizations/{id}/accept|reject`
- `POST /store/me/shifts/{id}/terms`
- `POST /store/me/shifts/{id}/terms/{proposalId}/cancel`
- `POST /driver/shifts/{id}/terms/{proposalId}/accept|reject`

Todas com tenant/RBAC, ownership e 404 sem vazamento entre lojas/entregadores.

## UI

- Driver: um botão por vínculo, rótulo completo da agenda, desabilitado com motivo (sem agenda, cedo, atraso), autorização/reajuste pendente com resumo e aceitar/recusar.
- Loja: múltiplas linhas do mesmo entregador distinguidas pela agenda; ação “Autorizar início atrasado”; reajuste ativo passa a mostrar “proposta pendente”.
- Valores sempre em centavos na API e BRL na UI.

## Testes obrigatórios

1. Agenda×agenda: borda, overnight, dow×date, interna, vazia e modalidade mista.
2. Corrida de duas confirmações sobrepostas: um sucesso/um 409.
3. Dois vínculos disjuntos na mesma loja e dois turnos sequenciais no mesmo dia, cada qual com diária.
4. Mesmo vínculo duas vezes na ocorrência: 409; outro motorista/vínculo: ownership 404.
5. Início em `start-30`, `start+30`, bordas externas, após fim, overnight e `schedule: []`.
6. Autorização: aceite/rejeição/cancelamento, fim original/novo fim, expiração, consumo único e conflito da extensão.
7. Remoção e confirmação de agenda durante ativo bloqueadas; mudança puramente financeira futura permitida.
8. Reajuste ativo não muda antes do aceite; próximas vs retroativo; redução e aumento; corrida com conclusão de entrega; encerrado recusa.
9. Última vaga concorrente e dois aceites conflitantes do mesmo driver continuam serializados.
10. Dispatch específico, OWN, batch e tokens sem fanout com múltiplos vínculos.
11. Rotas RBAC/tenant e migração de todas as chamadas antigas de `startShift`.
12. Gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

## Ordem de implementação

1. Shared: validação, conflitos e ocorrências.
2. Schema/migration/backfill/índices.
3. Vínculos e concorrência.
4. Turno por vínculo, snapshots e janela normal.
5. Ofertas e dispatch por FK.
6. Autorizações excepcionais.
7. Propostas de reajuste ativo.
8. Rotas e UIs.
9. Testes de regressão, docs e gate.

## Fora de escopo

- turno avulso para vínculo sem agenda;
- timezone por loja;
- cron/push novo;
- recorrência mensal avançada;
- alteração do modelo de ledger além dos ajustes já existentes.

---

## Revisão da implementação em andamento (2026-07-11)

Estado final: implementação completa no working tree. Os itens 1–17 abaixo foram usados como checklist de revisão e estão resolvidos. Migration aplicada com sucesso no banco dev; typecheck, testes, lint e builds passaram.

### Emenda: encerramento operacional e decisão da diária

- O driver encerra operacionalmente e fica livre para outro turno, mas a diária entra como `PENDING`.
- Entregas ainda associadas ou devolução pendente bloqueiam o encerramento.
- A loja aprova ou recusa a diária imediatamente; recusa exige motivo. Extras já concluídos não são afetados.
- A loja pode liberar reativação do mesmo turno por até 30 minutos, limitada ao fim programado; o driver reativa a mesma linha e não cria outra diária.
- Sem decisão, cron aprova automaticamente após 24 horas.
- Estados: `ACTIVE → PENDING_DAILY → REOPEN_ALLOWED|CLOSED`; reativação volta a `ACTIVE`.

Verificado e correto: resolução de ocorrência overnight (offsets −1/0/+1, `workDate` = data da ocorrência), tolerância ±30 com teto no fim da janela, snapshot `scheduledStartAt/scheduledEndAt` e comparação por timestamps absolutos, unique parcial de autorização por ocorrência, cancelamento de propostas PENDING no `closeShift`, migration com backfill validado antes do `SET NOT NULL` e drop do unique antigo só após o backfill, ordem de lock `usuário → recurso` em confirmações/aceite/start.

### Correções obrigatórias (bloqueiam commit)

1. **Typecheck quebrado (9 erros).** `driverActiveSchedule`/`assertNoScheduleConflict`/`pendingTermsForShift` recebem `tx` mas o parâmetro é `Db` (o client com `$client`). Padrão do repo: tipos estruturais `Pick<Db, ...>` (ver `LedgerWriter` em finance.service.ts:23). Tipar `db: Pick<Db, 'select'>` (e `'update'/'insert'` onde precisar).
2. **`updateActiveShift` removido mas ainda importado** por `test/own-drivers.service.test.ts:14` e `test/returns.service.test.ts:20`. Migrar esses testes para `proposeActiveShiftTerms` + `decideActiveShiftTerms` (propor pela loja, aceitar pelo driver).
3. **Dispatch viola a decisão 12.** Os 3 joins (`broadcastBatch` SPECIFIC, `setDriverRequestTarget` SPECIFIC, `listShiftDriverTokens`) mantêm o filtro `expiresAt > now`. Vínculo DATES expira exatamente no fim da última janela — turno overnight ainda ACTIVE após o fim programado deixaria de receber dispatch. Remover o filtro de expiry desses joins (o join por `store_driver_id` + shift ACTIVE + status CONFIRMED basta; remoção durante turno ativo já é bloqueada).
4. **`acceptOffer` engole qualquer erro como conflito**: `try { await assertNoScheduleConflict(...) } catch { throw new OfferError('Conflito...') }` mascara erro de DB. Capturar só `StoreDriverError` e relançar o resto.
5. **`expiresAt` só é definido no aceite de oferta.** Convite com agenda DATES (`inviteDriver`) e confirmação de termos que muda a agenda (`confirmLinkTermsChange`) não setam/atualizam/limpam `expiresAt`. Aplicar `datedScheduleExpiry(schedule)` nos dois (e `null` quando a agenda virar WEEKLY/vazia).
6. **`createShiftAuthorization` valida conflito sem lock do usuário** — corrida com `acceptOffer`/`confirmLink` concorrentes. Adicionar `users FOR UPDATE` antes da validação (ordem usuário → vínculo).
7. **`proposeActiveShiftTerms` sem transação/lock do turno** — proposta pode nascer depois do turno fechar (PENDING órfã em turno CLOSED). Envolver em tx com `for('update')` no turno ACTIVE.
8. **Guard de sobreposição do `startShift` varre todos os turnos do driver** (sem filtro temporal; não há índice por `driver_user_id`). Correto funcionalmente (timestamps absolutos), mas cresce sem limite. Filtrar `workDate` entre `addCivilDays(occurrence.workDate, -1)` e `+1`.
9. **`listDriverAuthorizations` só retorna PENDING** — o driver não enxerga autorização ACEITA (não sabe que o início está liberado nem até quando). Incluir `ACCEPTED` com `authorizedUntil` futuro; UI diferencia os dois estados.

### Limpeza

10. `AdjustActiveShiftSchema` ficou órfão no shared (rota PATCH removida) — remover.
11. `todaySP()` duplicado em offer.service — usar `saoPauloDate` do shared.
12. Comentário obsoleto em dispatch.service.ts:315 cita `updateActiveShift` — atualizar para `decideActiveShiftTerms`.

### Pendências (fases 8–9)

13. **Testes**: 6 arquivos chamam `startShift(..., storeId, ...)` (returns, own-drivers ×2, offers, batch) — migrar para `storeDriverId` do vínculo do setup. Escrever as 12 categorias de testes obrigatórios do spec (concorrência de confirmações, tolerância/bordas, autorização, reajuste com retroativo, fanout de dispatch, RBAC).
14. **UI driver** (DriverLayout + StoresView + nova seção): start ainda envia `storeId` (quebrado); botão por vínculo com estado (sem agenda / cedo / no horário / atrasado→autorização), aceitar/recusar autorização e proposta de reajuste com resumo em R$.
15. **UI loja** (StoreDriversView): reajuste chama `PATCH /store/me/shifts/{id}` removido (quebrado); migrar para propor/cancelar proposta + exibir "pendente"; ação "Autorizar início atrasado" (workDate, novo limite, fim opcional, valores opcionais, observação); distinguir vínculos pela agenda.
16. `pnpm --filter @delivery/api db:migrate` no banco de dev (obrigatório antes de subir a API).
17. Gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
